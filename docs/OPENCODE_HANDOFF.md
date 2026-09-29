# EDEN//0 — перший пакет для OpenCode

Стан: власник проєкту 28 вересня 2026 року явно дозволив передати потрібний код приватного репозиторію в OpenCode Zen для реалізації цього пакета.

## Режим роботи

- Працювати в ізольованій гілці `codex/eden-roadmap`.
- Виконувати один вузький пакет за раз; після нього Codex переглядає diff і запускає перевірки.
- Модель першого пакета: `opencode/longcat-2.5-preview-free`. Opus 5.5 розглядати тільки після його фактичної появи в доступних моделях.
- Не читати й не передавати ключі, `.env`, локальні збереження користувача або файли поза репозиторієм.

## Пакет 1 — вимірювана базова лінія

```text
You are working in the EDEN//0 TypeScript repository on branch codex/eden-roadmap.

Goal: improve the existing headless balance diagnostics so we can measure the
post-brain-v2 population decline and the agriculture/irrigation loop across
multiple seeds. Do not change simulation behavior, neural weights, UI, or
world balance in this task.

Inspect scripts/balance.ts, scripts/simulate.ts, World.computeStats(), Field,
Canal, and existing tests before editing. Extend scripts/balance.ts with
per-seed counts for fields, sown/ripened/harvested fields, canals and flowing
canals, food or harvest metrics that genuinely exist in the model, death
reasons, elapsed wall time, and ticks per second. Use actual model data; do not
infer harvests from merely having fields. If a requested metric does not exist,
mark it unavailable instead of inventing it. Keep the existing CLI arguments
and compact summary usable. Add machine-readable JSON output via an optional
CLI flag only if it is small and stable enough for later before/after comparison.

Add a focused automated check for any new counting or output logic, using the
project's current test conventions. Run typecheck and the focused test. Run a
short two-seed smoke check (at most 5000 ticks per seed). Do not run a long
benchmark in your own pass. Report the changed files, metrics, test commands,
and any metrics the data model cannot support yet. Do not commit.
```

## Контроль Codex після пакета

1. Переглянути diff на предмет змін поведінки симуляції та вигаданих метрик.
2. Запустити typecheck, цільові тести й короткий баланс-прогін.
3. Лише після прийняття пакета запустити однакові довгі seed до й після майбутніх змін балансу.

## Вже зроблено локально

- Діагностичні скрипти переведено з жорстко записаних 256 нейронів і 12 моторів на константи поточної мережі (341/17).
- `npm run typecheck` проходить; короткі `brain-probe` та `simulate` більше не дають `NaN` через розмір масивів.
- Acceptance: 43 автоматичні пункти пройшли, 1 не пройшов (друге покоління), 8 потребують UI.
