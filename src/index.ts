import dotenv from "dotenv";
import { Context, Telegraf } from "telegraf";

dotenv.config();

const token = process.env.BOT_TOKEN;

if (!token) {
  throw new Error("BOT_TOKEN is required");
}

const meetingUrl = process.env.MEETING_URL?.trim();
const googleClientId = process.env.GOOGLE_CLIENT_ID?.trim();
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
const googleRefreshToken = process.env.GOOGLE_REFRESH_TOKEN?.trim();
const targetChatIds = parseChatIds(process.env.TARGET_CHAT_IDS);
const meetingMessage = process.env.MEETING_MESSAGE?.trim() || "Созвон начинаем в 10:30 МСК. Ссылка на Google Meet:";
const meetingDays = new Set([2, 4]);
const meetingHourMoscow = 10;
const meetingMinuteMoscow = 30;
const moscowUtcOffsetHours = 3;

const helpText = [
  "Я manager-бот: по вторникам и четвергам в 10:30 МСК присылаю ссылку на общий созвон.",
  "",
  "/chatid — показать id этой группы для TARGET_CHAT_IDS",
  "/newmeet — создать новую ссылку Google Meet (для администратора группы)",
  "/help — эта справка",
].join("\n");

const bot = new Telegraf(token);

console.log("Manager bot config loaded", {
  botUsername: process.env.BOT_USERNAME || null,
  targetChatIdsCount: targetChatIds.size,
  hasMeetingUrl: Boolean(meetingUrl),
  hasGoogleMeetAccess: hasGoogleMeetAccess(),
  schedule: "Tuesday and Thursday, 10:30 Europe/Moscow",
});

bot.start((ctx) => ctx.reply(helpText));
bot.help((ctx) => ctx.reply(helpText));

bot.command("chatid", async (ctx) => {
  console.log("Chat ID requested", getChatLogInfo(ctx.chat));
  await ctx.reply(
    [
      `chat_id: ${ctx.chat.id}`,
      `chat_type: ${ctx.chat.type}`,
      ctx.chat.type === "private"
        ? "Добавьте бота в нужную группу и вызовите там /chatid."
        : "Добавьте это значение в TARGET_CHAT_IDS в .env.",
    ].join("\n"),
  );
});

bot.command("newmeet", async (ctx) => {
  if (!(await isChatAdministrator(ctx))) {
    await ctx.reply("Эта команда доступна только администраторам группы.");
    return;
  }

  try {
    const url = await createGoogleMeet();
    await ctx.reply(`${meetingMessage}\n${url}`);
    console.log("Manual Google Meet created", { chatId: ctx.chat.id, requestedBy: ctx.from?.id ?? null });
  } catch (error) {
    console.error("Manual Google Meet creation failed", { chatId: ctx.chat.id, error });
    await ctx.reply("Не смог создать Google Meet. Проверьте доступ Google в настройках бота.");
  }
});

bot.catch((error) => {
  console.error("Bot error", error);
});

bot.launch().then(() => {
  console.log("Manager bot is running", { botUsername: process.env.BOT_USERNAME || null });
  scheduleNextMeetingAnnouncement();
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

function scheduleNextMeetingAnnouncement(): void {
  const nextRunAt = getNextMeetingRunAt(new Date());
  const delayMs = nextRunAt.getTime() - Date.now();

  console.log("Next meeting announcement scheduled", { nextRunAt: nextRunAt.toISOString(), delayMs });

  setTimeout(async () => {
    await announceMeeting();
    scheduleNextMeetingAnnouncement();
  }, delayMs);
}

function getNextMeetingRunAt(now: Date): Date {
  const moscowNow = getMoscowDateParts(now);
  const firstCandidate = new Date(Date.UTC(moscowNow.year, moscowNow.month - 1, moscowNow.day));

  for (let offset = 0; offset < 8; offset += 1) {
    const candidateDate = new Date(firstCandidate);
    candidateDate.setUTCDate(candidateDate.getUTCDate() + offset);

    if (!meetingDays.has(candidateDate.getUTCDay())) {
      continue;
    }

    const candidate = new Date(
      Date.UTC(
        candidateDate.getUTCFullYear(),
        candidateDate.getUTCMonth(),
        candidateDate.getUTCDate(),
        meetingHourMoscow - moscowUtcOffsetHours,
        meetingMinuteMoscow,
      ),
    );

    if (candidate.getTime() > now.getTime()) {
      return candidate;
    }
  }

  throw new Error("Could not calculate the next meeting announcement time");
}

async function announceMeeting(): Promise<void> {
  if (targetChatIds.size === 0) {
    console.warn("Meeting announcement skipped: TARGET_CHAT_IDS is empty");
    return;
  }

  const url = await getMeetingUrlForAnnouncement();

  if (!url) {
    console.warn("Meeting announcement skipped: no Google Meet access and MEETING_URL is empty");
    return;
  }

  const text = `${meetingMessage}\n${url}`;
  const chatIds = [...targetChatIds];
  const results = await Promise.allSettled(
    chatIds.map((chatId) => bot.telegram.sendMessage(chatId, text)),
  );

  results.forEach((result, index) => {
    const chatId = chatIds[index];
    if (result.status === "fulfilled") {
      console.log("Meeting announcement sent", { chatId });
      return;
    }

    console.error("Meeting announcement failed", { chatId, error: result.reason });
  });
}

async function getMeetingUrlForAnnouncement(): Promise<string | undefined> {
  if (hasGoogleMeetAccess()) {
    try {
      return await createGoogleMeet();
    } catch (error) {
      console.error("Scheduled Google Meet creation failed; using fallback link when available", error);
    }
  }

  return meetingUrl;
}

async function createGoogleMeet(): Promise<string> {
  if (!hasGoogleMeetAccess()) {
    throw new Error("Google Meet credentials are not configured");
  }

  const accessToken = await getGoogleAccessToken();
  const response = await fetch("https://meet.googleapis.com/v2/spaces", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      config: {
        accessType: "OPEN",
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Google Meet API returned HTTP ${response.status}`);
  }

  const payload = (await response.json()) as { meetingUri?: string };
  if (!payload.meetingUri) {
    throw new Error("Google Meet API did not return a meeting URI");
  }

  return payload.meetingUri;
}

async function getGoogleAccessToken(): Promise<string> {
  const body = new URLSearchParams({
    client_id: googleClientId!,
    client_secret: googleClientSecret!,
    refresh_token: googleRefreshToken!,
    grant_type: "refresh_token",
  });
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) {
    throw new Error(`Google OAuth returned HTTP ${response.status}`);
  }

  const payload = (await response.json()) as { access_token?: string };
  if (!payload.access_token) {
    throw new Error("Google OAuth did not return an access token");
  }

  return payload.access_token;
}

function hasGoogleMeetAccess(): boolean {
  return Boolean(googleClientId && googleClientSecret && googleRefreshToken);
}

async function isChatAdministrator(ctx: Context): Promise<boolean> {
  const chat = ctx.chat;
  const from = ctx.from;

  if (!chat || !from || (chat.type !== "group" && chat.type !== "supergroup")) {
    return false;
  }

  const administrators = await ctx.getChatAdministrators();
  return administrators.some((member) => member.user.id === from.id);
}

function parseChatIds(input: string | undefined): Set<number> {
  return new Set(
    (input ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => Number(value))
      .filter((value) => Number.isSafeInteger(value) && value !== 0),
  );
}

function getMoscowDateParts(date: Date): { year: number; month: number; day: number } {
  const values = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(date);
  const valueByType = Object.fromEntries(
    values.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]),
  );

  return {
    year: Number(valueByType.year),
    month: Number(valueByType.month),
    day: Number(valueByType.day),
  };
}

function getChatLogInfo(chat: {
  id: number;
  type: string;
  title?: string;
  username?: string;
}): { id: number; type: string; title: string | null; username: string | null } {
  return {
    id: chat.id,
    type: chat.type,
    title: chat.title ?? null,
    username: chat.username ?? null,
  };
}
