# Кто платит

Telegram Mini App для разделения расходов с друзьями.

Приложение позволяет создать сессию, добавить участников, записать расходы и увидеть итог: кто кому должен перевести деньги.

## Локальный запуск

Установите зависимости:

```bash
npm install
```

Запустите проект:

```bash
npm run dev
```

После запуска откройте адрес, который покажет Vite, обычно:

```text
http://localhost:5173
```

## Сборка проекта

```bash
npm run build
```

Готовая сборка появится в папке `dist`.

## Деплой на Vercel

1. Загрузите проект на GitHub.
2. Откройте Vercel.
3. Нажмите `Add New...` -> `Project`.
4. Выберите GitHub-репозиторий с проектом.
5. Framework Preset: `Vite`.
6. Build Command: `npm run build`.
7. Output Directory: `dist`.
8. Нажмите `Deploy`.

## Telegram Mini App

В проект подключён Telegram Web Apps SDK:

```html
<script src="https://telegram.org/js/telegram-web-app.js"></script>
```

После деплоя на HTTPS-адрес этот URL можно указать в BotFather как Menu Button для Telegram Mini App.
