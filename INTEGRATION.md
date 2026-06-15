# Интеграция GitLab MR MCP в Cursor

Краткая инструкция для локального подключения к `https://code.simplex48.ru`.

## 1. Установка

```bash
npm install
```

## 2. Токен GitLab

1. Создайте Personal Access Token: https://example.gitlab.ru/-/profile/personal_access_tokens
2. Scope: `api` или `read_api` (для комментариев и правок MR нужен `api`).

Системные переменные Windows **не нужны** — токен задаётся в конфиге MCP.

## 3. Конфиг Cursor

Файл: `%USERPROFILE%\.cursor\mcp.json`

```json
{
  "mcpServers": {
    "gitlab-mr-mcp": {
      "command": "node",
      "args": ["D:/dev/pets/gitlab-mr-mcp/index.js"],
      "env": {
        "MR_MCP_GITLAB_TOKEN": "ваш_токен",
        "MR_MCP_GITLAB_HOST": "https://code.simplex48.ru"
      }
    }
  }
}
```

Путь в `args` замените на свой, если репозиторий лежит в другом месте.

### Опционально

```json
"MR_MCP_MIN_ACCESS_LEVEL": "30",
"MR_MCP_PROJECT_SEARCH_TERM": "clinicWeb"
```

## 4. Запуск

В Cursor: **Settings → MCP** → refresh у `gitlab-mr-mcp`.

Проверка в чате:

- «Покажи проекты в GitLab через MCP»
- «Какие merge request открыты в проекте front?»

## 5. Инструменты

| Инструмент | Назначение |
|------------|------------|
| `get_projects` | Список доступных проектов |
| `list_open_merge_requests` | Открытые MR (`project_id` обязателен) |
| `get_merge_request_details` | Детали MR |
| `get_merge_request_diff` | Diff MR |
| `get_merge_request_comments` | Комментарии MR |
| `add_merge_request_comment` | Общий комментарий |
| `add_merge_request_diff_comment` | Комментарий к строке в diff |
| `get_issue_details` | Детали issue |
| `set_merge_request_title` | Изменить заголовок MR |
| `set_merge_request_description` | Изменить описание MR |

## 6. Troubleshooting

| Симптом | Решение |
|---------|---------|
| `Connection closed` сразу после старта | Убедитесь, что в `index.js` используется `fileURLToPath(import.meta.url)` для проверки main-модуля (Windows). |
| `expected a Zod schema...` | Схемы инструментов передаются как `{ field: z.string() }`, не как `z.object({...})`. |
| `403 Forbidden` | Проверьте scope токена и доступ к проекту. |
| `MR_MCP_GITLAB_TOKEN is not set` | Токен должен быть в `env` блока `mcp.json`, не в переменных ОС. |

## 7. Отладка

```bash
set MR_MCP_GITLAB_TOKEN=ваш_токен
set MR_MCP_GITLAB_HOST=https://example.gitlab.ru
npx -y @modelcontextprotocol/inspector npm start
```
