# Manager Bot

Telegram-бот для рабочих групп. Сейчас он автоматически отправляет ссылку на общий Google Meet по вторникам и четвергам в 10:30 по Москве.

## Запуск

```bash
npm install
cp .env.example .env
npm run dev
```

## Настройка

В `.env` заполните:

- `BOT_TOKEN` — токен из BotFather.
- `TARGET_CHAT_IDS` — id групп через запятую.
- `MEETING_URL` — запасная ссылка Google Meet, если доступ Google временно недоступен.
- `MEETING_MESSAGE` — текст перед ссылкой, необязательно.
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` — OAuth-данные Google с разрешением `https://www.googleapis.com/auth/meetings.space.created`.

Добавьте бота в каждую рабочую группу. Вызовите в ней `/chatid` и вставьте полученный `chat_id` в `TARGET_CHAT_IDS`. Затем перезапустите бота.

Пример:

```env
TARGET_CHAT_IDS=-1001234567890,-1009876543210
MEETING_URL=https://meet.google.com/abc-defg-hij
```

Расписание считается в часовом поясе `Europe/Moscow`, поэтому не зависит от часового пояса сервера.

## Новая ссылка Google Meet

Команда `/newmeet` доступна администраторам рабочей группы: она создаёт отдельный открытый Google Meet и сразу отправляет ссылку в чат. Любой человек со ссылкой сможет подключиться без подтверждения организатора. При заполненных OAuth-переменных автоматические рассылки во вторник и четверг тоже создают новую открытую ссылку для каждого созвона. Без них бот использует `MEETING_URL`.

## Уведомления о коммитах GitHub

Бот принимает GitHub Organization Webhook по адресу `/webhooks/github` и отправляет в `GITHUB_COMMIT_CHAT_IDS` сообщение о каждом коммите из события `push`: проект, автора, ссылку и сообщение коммита.

В Railway задайте `GITHUB_WEBHOOK_SECRET` (случайный секрет) и `GITHUB_COMMIT_CHAT_IDS` (id Telegram-группы). Затем в настройках организации GitHub создайте Webhook с URL `https://<railway-domain>/webhooks/github`, тем же секретом, форматом `application/json` и единственным событием `Pushes`.

## Дальше

На этой основе можно добавить постановку задач, вопросы в группы, сбор контекста и аналитику. Сейчас бот не читает и не анализирует переписку и не использует AI-ключи.
