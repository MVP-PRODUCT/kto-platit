export default async function handler(request, response) {
  if (request.method !== 'POST') {
    response.status(200).json({ ok: true });
    return;
  }

  try {
    const update = request.body;
    const message = update?.message;
    const text = message?.text;
    const chatId = message?.chat?.id;

    if (chatId && typeof text === 'string' && text.startsWith('/start')) {
      const token = process.env.TELEGRAM_BOT_TOKEN;

      if (token) {
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            chat_id: chatId,
            text:
              'Привет 👋\n\n' +
              'Это приложение для разделения расходов с друзьями.\n\n' +
              'Создай сессию, добавь участников и расходы — мы сами посчитаем, кто кому должен.',
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: 'Открыть приложение',
                    web_app: {
                      url: 'https://kto-platit-delta.vercel.app',
                    },
                  },
                ],
              ],
            },
          }),
        });
      } else {
        console.error('TELEGRAM_BOT_TOKEN is missing');
      }
    }
  } catch (error) {
    console.error('Telegram webhook error', error);
  }

  response.status(200).json({ ok: true });
}
