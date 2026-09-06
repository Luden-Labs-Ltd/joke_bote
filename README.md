# Manager Bot

Telegram-бот для рабочих групп. Сейчас он автоматически отправляет ссылку на общий Google Meet с понедельника по четверг в 10:30 по Москве.

## Запуск

```bash
npm install
cp .env.example .env
npm run dev
```

## Настройка

В `.env` заполните:

- `BOT_TOKEN` — токен из BotFather.
- `TARGET_CHAT_IDS` — необязательный первоначальный список id групп через запятую.
- `MEETING_SUBSCRIPTIONS_FILE` — путь к постоянному файлу подписок групп. На Railway используйте `/data/meeting-subscriptions.json` и подключите Volume в `/data`.
- `MEETING_SUMMARY_FILE` — путь к состоянию ожидающих итогов Meet. На Railway используйте `/data/meeting-summaries.json` в том же Volume.
- `MEETING_SUMMARY_CHAT_IDS` — id групп Telegram через запятую, куда отправлять итоги созвонов.
- `MEETING_URL` — запасная ссылка Google Meet, если доступ Google временно недоступен.
- `MEETING_MESSAGE` — текст перед ссылкой, необязательно.
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` — OAuth-данные Google с разрешением `https://www.googleapis.com/auth/meetings.space.created`.

Добавьте бота в каждую рабочую группу и вызовите там `/startmeet` от имени администратора. Бот запомнит группу и с понедельника по четверг пришлёт ссылку за 10 минут до созвона, а в 10:30 МСК — повторное английское сообщение с этой же ссылкой. Для отключения используйте `/stopmeet`.

Пример:

```env
TARGET_CHAT_IDS=-1001234567890,-1009876543210
MEETING_SUBSCRIPTIONS_FILE=/data/meeting-subscriptions.json
MEETING_SUMMARY_FILE=/data/meeting-summaries.json
MEETING_SUMMARY_CHAT_IDS=-1001234567890
MEETING_URL=https://meet.google.com/abc-defg-hij
```

Расписание считается в часовом поясе `Europe/Moscow`, поэтому не зависит от часового пояса сервера.

## Новая ссылка Google Meet

Команда `/newmeet` доступна администраторам рабочей группы: она создаёт отдельный открытый Google Meet и сразу отправляет ссылку в чат. Любой человек со ссылкой сможет подключиться без подтверждения организатора. При заполненных OAuth-переменных автоматические рассылки с понедельника по четверг тоже создают новую открытую ссылку для каждого созвона. Без них бот использует `MEETING_URL`.

## Итоги созвонов

Для новых Meet-ссылок бот запрашивает автотранскрипцию. Когда расшифровка готова, бот получает её через Meet API, делает в Gemini короткий итог с решениями и задачами и отправляет его в `MEETING_SUMMARY_CHAT_IDS`. Если транскрипция недоступна для Google-аккаунта или тарифа, ссылка на Meet всё равно создаётся, но итог не будет отправлен. Для надёжности подключения групп и ожидания итогов подключите Railway Volume в `/data`.

## Уведомления о коммитах GitHub

Бот принимает GitHub Organization Webhook по адресу `/webhooks/github` и отправляет в `GITHUB_COMMIT_CHAT_IDS` сообщение о каждом коммите из события `push`: проект, автора, ссылку и короткое понятное описание изменений.

В Railway задайте `GITHUB_WEBHOOK_SECRET` (случайный секрет), `GITHUB_COMMIT_CHAT_IDS` (id Telegram-группы) и `GEMINI_API_KEY`. Необязательная `GEMINI_MODEL` задаёт модель Gemini, по умолчанию используется `gemini-2.5-flash`. Если Gemini временно недоступен, бот всё равно пришлёт уведомление с исходным сообщением коммита. Затем в настройках организации GitHub создайте Webhook с URL `https://<railway-domain>/webhooks/github`, тем же секретом, форматом `application/json` и единственным событием `Pushes`.

## Дальше

На этой основе можно добавить постановку задач, вопросы в группы, сбор контекста и аналитику. Бот не читает и не анализирует переписку.
