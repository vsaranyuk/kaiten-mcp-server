# Kaiten MCP Server

MCP сервер для интеграции Kaiten API с Claude Desktop. Позволяет управлять карточками, комментариями и пространствами Kaiten напрямую из Claude.

## Возможности

- **Карточки:** Чтение, создание, обновление, удаление, поиск
- **Комментарии:** Полная работа с комментариями карточек
- **Пространства и доски:** Навигация по структуре Kaiten
- **Поиск:** Продвинутый поиск с фильтрами
- **Default Space:** Автоматическая работа в выбранном пространстве
- **🔒 Production-Ready:**
  - Zod validation для всех параметров
  - Автоматический retry с exponential backoff
  - Concurrency control (rate limiting)
  - LRU кеш с TTL для spaces/boards/users
  - Расширенная обработка ошибок с hints
  - Редакция токенов в логах

## Быстрый старт

### 1. Установка

```bash
npm install
```

### 2. Настройка .env

Создайте файл `.env`:

```bash
cp .env.example .env
```

Заполните его вашими данными:

```env
KAITEN_API_URL=https://your-domain.kaiten.ru/api/latest
KAITEN_API_TOKEN=your_api_token_here
KAITEN_DEFAULT_SPACE_ID=12345  # Ваш основной space_id

# Опциональные настройки производительности (значения по умолчанию)
KAITEN_MAX_CONCURRENT_REQUESTS=5     # Макс. одновременных запросов (1-20)
KAITEN_CACHE_TTL_SECONDS=300         # Время жизни кеша в секундах (0 = выкл.)
KAITEN_REQUEST_TIMEOUT_MS=10000      # Таймаут запроса в мс (1-60000)
```

**Как получить API токен:**
1. Войдите в Kaiten
2. Откройте настройки профиля
3. Создайте новый API токен
4. Скопируйте и вставьте в `.env`

### 3. Сборка

```bash
npm run build
```

### 4. Настройка Claude Desktop

Откройте конфигурационный файл:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux:** `~/.config/Claude/claude_desktop_config.json`

Добавьте (замените путь на ваш полный путь):

```json
{
  "mcpServers": {
    "kaiten": {
      "command": "node",
      "args": [
        "/полный/путь/к/MCP Kaiten/dist/index.js"
      ],
      "cwd": "/полный/путь/к/MCP Kaiten"
    }
  }
}
```

**Альтернативный способ (без .env):**

```json
{
  "mcpServers": {
    "kaiten": {
      "command": "node",
      "args": ["/полный/путь/к/MCP Kaiten/dist/index.js"],
      "env": {
        "KAITEN_API_URL": "https://your-domain.kaiten.ru/api/latest",
        "KAITEN_API_TOKEN": "your_api_token_here",
        "KAITEN_DEFAULT_SPACE_ID": "12345"
      }
    }
  }
}
```

### 5. Перезапустите Claude Desktop

Полностью закройте (⌘+Q / Alt+F4) и откройте Claude Desktop заново.

### 6. Проверка

Напишите в Claude:

```
Покажи список пространств Kaiten
```

## Доступные инструменты (25 tools)

### Карточки
- `kaiten_get_card` - Получить карточку по ID
- `kaiten_create_card` - Создать новую карточку
- `kaiten_update_card` - Обновить карточку
- `kaiten_delete_card` - Удалить карточку
- `kaiten_search_cards` - Поиск карточек с фильтрами
- `kaiten_get_space_cards` - Получить карточки пространства
- `kaiten_get_board_cards` - Получить карточки доски

### Комментарии
- `kaiten_get_card_comments` - Получить комментарии карточки
- `kaiten_create_comment` - Создать комментарий
- `kaiten_update_comment` - Обновить комментарий
- `kaiten_delete_comment` - Удалить комментарий

### Пространства и доски
- `kaiten_list_spaces` - Список всех пространств
- `kaiten_get_space` - Получить пространство
- `kaiten_list_boards` - Список досок
- `kaiten_get_board` - Получить доску

### Справочники (для корректных ID)
- `kaiten_list_columns` - Список колонок (статусов) доски
- `kaiten_list_lanes` - Список дорожек (lanes/swimlanes) доски
- `kaiten_list_types` - Список типов карточек доски

### Пользователи
- `kaiten_get_current_user` - Получить текущего пользователя
- `kaiten_list_users` - Список пользователей

### Управление кешем и диагностика
- `kaiten_cache_invalidate_spaces` - Инвалидировать кеш пространств
- `kaiten_cache_invalidate_boards` - Инвалидировать кеш досок
- `kaiten_cache_invalidate_users` - Инвалидировать кеш пользователей
- `kaiten_cache_invalidate_all` - Инвалидировать весь кеш
- `kaiten_get_status` - Получить статус сервера (кеш, очередь, конфигурация)

## Примеры использования

### Базовые операции

```
Покажи карточку 789
```

```
Создай карточку "Исправить баг" на доске 456 с описанием "Проблема с авторизацией"
```

```
Обнови карточку 789: измени статус на 3
```

```
Добавь комментарий к карточке 789: "Работа завершена"
```

### Поиск

```
Найди карточки со словом "авторизация" на доске 456
```

```
Покажи мои карточки в пространстве 123
```

```
Найди все карточки в работе на доске 456
```

### Default Space

По умолчанию все операции выполняются в пространстве, указанном в `KAITEN_DEFAULT_SPACE_ID`. Это делает команды короче:

```
Найди карточку про Болгарию
# Автоматически ищет в DEFAULT_SPACE_ID
```

Для поиска во всех пространствах явно укажите:

```
Найди карточку про Болгарию во ВСЕХ пространствах
```

Подробнее о Default Space см. [DEFAULT_SPACE_GUIDE.md](./DEFAULT_SPACE_GUIDE.md)

## Оптимизация и производительность

### ✅ Лучшие практики поиска

**DO (Делайте так):**

```
Найди карточки "баг" на доске 456
```

**DON'T (Не делайте так):**

```
Покажи все карточки пространства и найди среди них "баг"
```

### Параметры поиска

- `limit` - количество карточек (по умолчанию 10)
- `sort_by` - сортировка: `created`, `updated`, `title`
- `sort_direction` - направление: `asc`, `desc`
- `condition` - 1=активные (по умолчанию), 2=архивные

### Примеры с параметрами

```
Найди 20 карточек на доске 456
```

```
Покажи архивные карточки на доске 456
```

```
Найди карточки на доске 456, отсортированные по дате обновления
```

## Структура проекта

```
MCP Kaiten/
├── src/
│   ├── index.ts          # MCP сервер
│   └── kaiten-client.ts  # Kaiten API клиент
├── dist/                 # Скомпилированные файлы
├── .env                  # Конфигурация (не в git)
├── .env.example          # Пример конфигурации
├── tsconfig.json         # TypeScript конфигурация
├── package.json
├── README.md             # Этот файл
├── CHANGELOG.md          # История изменений
└── DEFAULT_SPACE_GUIDE.md # Руководство по Default Space
```

## Возможности карточек

При получении карточки возвращаются следующие поля:

```json
{
  "id": 12345,
  "title": "Название карточки",
  "url": "https://your-domain.kaiten.ru/space/12345/card/12345",
  "description": "Полное описание...",
  "created": "2025-07-23T07:55:52.934Z",
  "updated": "2025-10-01T12:14:47.754Z",
  "state": 2,
  "owner_id": 67890,
  "owner_name": "Иван Иванов",
  "board_id": 54321,
  "board_title": "Project Board",
  "blocked": true,
  "block_reason": "Ожидание данных от команды",
  "blocked_at": "2025-08-04T09:10:22.528Z",
  "blocker_name": "Иван Иванов",
  "archived": false,
  "tags": ["важно", "срочно"],
  "members": ["Иван Иванов", "Мария Петрова"],
  "due_date": "2025-10-19T00:00:00.000Z"
}
```

## Устранение неполадок

### Сервер не подключается

1. Проверьте правильность пути в конфигурации Claude
2. Убедитесь, что проект собран: `npm run build`
3. Проверьте `.env` файл
4. Перезапустите Claude Desktop полностью (⌘+Q)

### Ошибки API

- Проверьте, что токен действителен
- URL должен заканчиваться на `/api/latest`
- Проверьте права доступа токена в настройках Kaiten

### Ошибка "Tool result is too large"

Используйте фильтры и параметр `board_id`:

```
# Плохо
Найди карточки в пространстве 123

# Хорошо
Найди карточки на доске 456 в пространстве 123
```

### Отладка

Логи сервера выводятся в stderr. На macOS/Linux их можно посмотреть через Console.app или запустив Claude из терминала.

## Технические детали

- **Node.js:** Версия 20 или выше (требование `engines`)
- **TypeScript:** 5.0+
- **MCP SDK:** @modelcontextprotocol/sdk v1.20.0
- **API Client:** axios с retry/backoff и AbortSignal support
- **Размер:** ~600 строк TypeScript, 25KB скомпилированного кода

### MCP I/O Protocol

**Критично для отладки:** MCP использует stdio-транспорт для общения между клиентом и сервером.

- **stdout** — только JSON-RPC протокольные сообщения (чистый канал связи)
- **stderr** — все логи, дебаг-информация, ошибки

**Важно:**
- Любой `console.log()` в коде нарушает протокол → используйте `console.error()` для логов
- Этот сервер гарантирует чистоту stdout через `safeLog` wrapper (src/config.ts:126-152)
- При отладке смотрите stderr: `node dist/index.js 2>debug.log` или используйте MCP Inspector

Подробнее: [Build an MCP server](https://modelcontextprotocol.io/docs/getting-started/build-an-mcp-server)

## История версий

См. [CHANGELOG.md](./CHANGELOG.md) для полной истории изменений.

**Текущая версия:** 2.2.0

### Основные обновления:

- **v2.2.0** - 🎨 UX/Architecture: Verbosity modes, Idempotency keys, Board справочники (columns/lanes/types)
- **v2.1.0** - 🔒 Production-Ready: Retry/Backoff, Concurrency control, LRU cache, Enhanced errors
- **v2.0.0** - 🎉 Major update: Zod validation, Resources, Server Prompts, enhanced types
- **v1.5.0** - Default Space support
- **v1.4.1** - Улучшенная стратегия поиска
- **v1.4.0** - Фильтр активных карточек по умолчанию
- **v1.3.0** - Критическая оптимизация (размеры уменьшены на 92-97%)
- **v1.2.0** - Сортировка и pagination
- **v1.1.0** - Расширенные фильтры поиска
- **v1.0.0** - Первый релиз

## Лицензия

MIT

## Документация

- **[TOOLS.md](./TOOLS.md)** - Полный справочник всех 17 инструментов
- **[CHANGELOG.md](./CHANGELOG.md)** - История изменений
- **[DEFAULT_SPACE_GUIDE.md](./DEFAULT_SPACE_GUIDE.md)** - Руководство по Default Space
- **[Kaiten API Docs](https://developers.kaiten.ru/)** - Официальная документация API
