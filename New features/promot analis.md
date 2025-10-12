⏺ Анализ системного промпта MCP сервера Kaiten

  📊 Текущее состояние

  Размер промпта: ~960 слов (≈1200-1400 токенов)
  Местоположение: /Users/vladimirsaraniuk/Documents/Projects/MCP Kaiten/src/index.ts:238-367

  ✅ Что сделано ХОРОШО (соответствует best practices 2025)

  1. Структурированность - промпт разделен на логические секции:
    - Key capabilities
    - Tool Usage (детальные инструкции по каждому инструменту)
    - Best practices
    - Resource patterns
    - Error handling
  2. Конкретные инструкции по оптимизации производительности:
    - ✅ "ALWAYS use space_id or board_id to avoid searching everywhere"
    - ✅ "limit: default 10, max 100 (keep ≤20 when possible)"
    - ✅ Явные указания на использование фильтров
  3. Четкие примеры использования:
    - ✅ Примеры корректных запросов
    - ✅ Объяснение форматов данных (ISO 8601)
    - ✅ Указание на Latin vs Cyrillic для имен пользователей
  4. Вы уже применили современную практику - возврат текста вместо JSON для kaiten_search_cards
  (src/index.ts:1394-1420) сокращает токены на ~80%

  ⚠️ Проблемы и возможности для оптимизации

  1. ИЗБЫТОЧНОСТЬ в описаниях инструментов

  Проблема: Дублирование информации между:
  - Tool descriptions (src/index.ts:373-983)
  - System prompt (src/index.ts:244-367)

  Пример:
  // Tool description:
  description: 'Search for cards with flexible filters including date ranges...'

  // Затем в промпте ПОВТОРЯЕТСЯ:
  - kaiten_search_cards:
    - CRITICAL FOR PERFORMANCE: ALWAYS use space_id...
    - query: uses partial case-insensitive matching...

  Best Practice 2025:
  "Use concise, focused comments to explain inputs. Eliminate verbose auto-generated documentation."

  Рекомендация: Сократить промпт на 30-40%, перенеся детали в inputSchema.properties.{field}.description.

  2. ДЛИННЫЕ описания параметров в tools

  Проблема: Каждый tool definition загружается в контекст LLM при каждом запросе.

  Текущий пример:
  query: {
    type: 'string',
    description: 'Search query for partial case-insensitive matching. Searches in card title, description, and 
  comments. Use root words for better results (e.g., "болгар" instead of "болгария" to match all forms). If no 
  results, try without query parameter.',
  }

  Best Practice 2025:
  "Write Minimal, Clear Descriptions - Provide just enough context for the LLM to understand the tool."

  Рекомендация: Сократить до:
  query: {
    type: 'string',
    description: 'Partial case-insensitive search in title/description/comments',
  }

  3. Возврат JSON вместо текста в некоторых tools

  Проблема: Большинство tools возвращают JSON.stringify(), что расходует на 80% больше токенов.

  Текущие tools с JSON output:
  - kaiten_get_card (1190)
  - kaiten_get_space_cards (1439)
  - kaiten_get_board_cards (1460)
  - kaiten_list_spaces (1478)
  - kaiten_get_board (1545)
  - И другие...

  Best Practice 2025:
  "Plain text formatting uses roughly 80% fewer tokens compared to JSON"
  "By filtering responses and reducing JSON, token usage can be reduced by 93-98%"

  Рекомендация: Применить human-readable форматирование (как в kaiten_search_cards) к часто используемым tools.

  4. Промпт содержит справочную информацию

  Проблема: Секция "Resource patterns" и "Error handling" - это справочная информация, которую LLM может вывести
  из контекста.

  Resource patterns:
  - kaiten-card:///{cardId} - Single card...
  - kaiten-space:///{spaceId} - Space with boards...

  Error handling:
  - Validation errors provide detailed field-level feedback
  - API errors include response status and details

  Рекомендация: Убрать эти секции - LLM поймет паттерны из примеров использования.

  📋 Конкретные рекомендации по оптимизации

  Приоритет 1: Критично для производительности 🔴

  1. Сократить промпт на 40-50% (с 960 до 500-550 слов)
    - Убрать секции Resource patterns и Error handling (~100 слов)
    - Сократить Tool Usage секцию, оставив только критичные инструкции (~200 слов)
    - Перенести детали в inputSchema descriptions
  2. Применить text-форматирование к топ-5 часто используемым tools:
    - kaiten_get_card - вместо JSON вернуть красиво форматированную карточку
    - kaiten_list_spaces - вместо JSON список с эмодзи
    - kaiten_get_board_cards - как kaiten_search_cards
    - Потенциальная экономия: 70-80% токенов на этих операциях

  Приоритет 2: Хорошо иметь 🟡

  3. Сократить descriptions в inputSchema на 50%
    - Текущие: ~50-100 слов на tool
    - Целевые: 20-30 слов на tool
    - Убрать примеры из descriptions (LLM понимает из промпта)
  4. Добавить prompt caching hints
    - Структурировать промпт так, чтобы статичные части кэшировались
    - Выделить "редко меняющиеся" инструкции в начало

  Приоритет 3: Дополнительно 🟢

  5. Разделить промпт на "базовый" и "расширенный"
    - Базовый: основные 5-6 tools (kaiten_search_cards, kaiten_create_card, kaiten_get_card)
    - Расширенный: остальные tools (загружается по требованию)
  6. Добавить метрики использования токенов
    - Логировать размер ответов в токенах
    - Идентифицировать самые "дорогие" операции

  📊 Ожидаемый эффект от оптимизации

  | Оптимизация                         | Экономия токенов                                     | Сложность  |
  |-------------------------------------|------------------------------------------------------|------------|
  | Сокращение промпта (960→500 слов)   | -600 токенов при каждом запросе                      | Низкая ⭐   |
  | Text-форматирование топ-5 tools     | -70-80% на часто используемых операциях              | Средняя ⭐⭐ |
  | Сокращение inputSchema descriptions | -30-40 токенов на tool × 24 tools = -720-960 токенов | Низкая ⭐   |
  | ИТОГО:                              | ~2000-2500 токенов экономии                          |            |

  🎯 Заключение

  Текущий промпт: Хороший, структурированный, но избыточный по современным стандартам 2025.

  Оценка: 7/10
  - ✅ Структура отличная
  - ✅ Примеры конкретные
  - ✅ Уже применен text-форматирование для search
  - ⚠️ Слишком многословный (можно сократить на 40-50%)
  - ⚠️ Дублирование информации между prompt и tool descriptions
  - ⚠️ JSON вместо текста в большинстве tools (80% лишних токенов)

  Главная рекомендация: Применить принцип "Minimal Viable Prompt":
  "Provide just enough context for the LLM to understand the tool. Every saved token is more context your agent 
  can use to actually help users."