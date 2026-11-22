Vektor Terminal --- полная продуктовая и техническая спецификация для
Claude

**Версия документа:** 1.0\
**Дата:** 22 ноября 2026 года\
**Назначение:** исходное техническое задание для Claude Code/другого
AI-агента-разработчика\
**Рабочее название продукта:** Vektor Terminal

0\. Как использовать этот документ

Этот файл является единым product brief и техническим ориентиром для
разработки Vektor Terminal. Claude должен использовать его как источник
продуктовых решений, но не считать его заменой проверке документации
конкретной биржи, API-ограничений, лицензий TradingView, требований
безопасности и юридической модели.

Если требование невозможно реализовать безопасно или его поведение
зависит от конкретной биржи, Claude должен:

1.  явно отметить зависимость;

2.  не имитировать поддержку функции;

3.  добавить capability flag для конкретного коннектора;

4.  показать пользователю понятное объяснение ограничения;

5.  предложить безопасный fallback или запросить уточнение.

Нельзя молча угадывать критические торговые параметры, автоматически
расширять права API-ключа, выдавать неподтверждённый сигнал за
рекомендацию Vektor или заявлять поддержку биржи без интеграционного
теста.

1\. Краткое описание продукта

Vektor Terminal --- мультиязычный non-custodial криптотерминал для
ручного и автоматизированного исполнения торговых действий на
подключённых биржах.

Пользователь может:

-   торговать вручную через единый интерфейс;

-   подключить несколько бирж через API-ключи без разрешения на вывод
    средств;

-   получать внешние сигналы из TradingView, Telegram, Discord, webhook,
    API, внешних ботов и ручных команд;

-   переводить текстовую или голосовую команду в формальную торговую
    операцию;

-   видеть операцию на графике до и после исполнения;

-   задавать тейк-профиты, стоп-лоссы, трейлинг, безубыток, частичные
    закрытия и усреднение там, где это поддерживает коннектор;

-   контролировать лимиты, плечо, экспозицию, размер позиции, допустимые
    площадки и режимы подтверждения;

-   использовать paper mode и dry-run до live execution;

-   просматривать полную историю: исходный сигнал, интерпретацию,
    проверки, policy decision, ордер, fills, fees, P&L и ошибки.

**Vektor не генерирует торговые сигналы, не продаёт прогнозы и не
обещает win rate или прибыль.** Пользователь сам выбирает источник
сигнала. Vektor отвечает за интерфейс, нормализацию, проверку
технической исполнимости, применение правил пользователя, маршрутизацию,
исполнение, отображение и аудит.

2\. Главные продуктовые принципы

2.1. Non-custodial по умолчанию

Vektor не хранит пользовательские средства и не должен требовать
разрешение на вывод средств. Средства остаются на подключённой бирже.

Для каждого коннектора по умолчанию:

-   разрешены только чтение и торговля;

-   withdrawal/transfer permissions запрещены;

-   API permissions проверяются при подключении и периодически после
    него;

-   пользователю показывается точный список разрешений;

-   ключ можно отозвать из Vektor и напрямую на бирже;

-   поддерживается IP allowlist, если это позволяет биржа;

-   ключи разделяются по бирже, аккаунту, окружению и workspace.

2.2. AI предлагает, но не является источником истины

LLM может:

-   распознать текст;

-   расшифровать голос;

-   извлечь параметры внешнего сигнала;

-   объяснить ошибку;

-   подготовить draft операции;

-   ответить на вопросы по журналу и портфелю.

LLM не может самостоятельно:

-   изменить policy;

-   расширить API permissions;

-   придумать отсутствующий размер позиции;

-   заменить неизвестный символ другим без показа пользователю;

-   включить live trading без предусмотренного подтверждения;

-   изменить максимальный риск;

-   выдать собственный прогноз за внешний сигнал;

-   скрыть ошибку биржи или неисполненный ордер.

Источником истины являются каноническая команда, детерминированный
validator, policy engine и ответ биржи.

2.3. Сначала preview, затем действие

Любая потенциально опасная операция должна проходить путь:

> Input
>
> → provenance
>
> → parsing
>
> → normalization
>
> → capability check
>
> → preflight validation
>
> → policy evaluation
>
> → cost/risk preview
>
> → confirmation или bounded auto-execution
>
> → submit
>
> → exchange events
>
> → reconciliation
>
> → audit trail

2.4. Не выдавать функцию за moat

Следующие возможности сами по себе не являются уникальным преимуществом
и должны рассматриваться как базовая функциональность:

-   API-подключение;

-   webhook;

-   TradingView alerts;

-   несколько бирж;

-   текстовый AI;

-   голос;

-   paper trading;

-   TP/SL;

-   Grid/DCA;

-   журнал;

-   ручное подтверждение.

Потенциально защищаемая ценность Vektor --- в качестве связки:

-   единая семантика команд между биржами;

-   техническая проверка исполнимости;

-   переносимые policy rules;

-   provenance и idempotency;

-   объяснимые причины отказа;

-   измеримые latency, slippage, fill quality и connector health;

-   командные approval workflows;

-   экспортируемость и устойчивость к закрытию самого Vektor.

3\. Целевые пользователи

3.1. Solo trader

Пользователь работает с одной или несколькими биржами, получает сигналы
из TradingView или Telegram, не успевает вручную исполнять каждый сигнал
и хочет уменьшить количество ошибок.

Основные задачи:

-   быстро понять сигнал;

-   проверить, не устарел ли он;

-   автоматически или полуавтоматически открыть позицию;

-   сразу выставить защитные параметры;

-   видеть, что именно произошло;

-   не передавать сервису право на вывод средств.

3.2. Active multi-exchange trader

Работает с Binance, Bybit, OKX и другими площадками, использует spot и
futures, сравнивает комиссии и сталкивается с разными правилами
символов, precision, leverage, hedge mode и order types.

3.3. Small trading team

Нужны:

-   workspace;

-   роли;

-   approval workflow;

-   разделение доступа к API;

-   общий журнал;

-   policy versioning;

-   экспорт аудита;

-   связь пользователей с аккаунтами и субаккаунтами.

3.4. Signal provider

Автор внешних сигналов может использовать Vektor как технический
execution layer, не передавая ему право генерировать прогнозы.

Возможности:

-   структурированный формат сигналов;

-   тестовый webhook;

-   versioned schema;

-   delivery status;

-   replay;

-   подключение нескольких клиентских workspace с отдельными scopes.

4\. Навигация приложения

Основные разделы интерфейса:

6.  **Overview** --- общий обзор аккаунтов, equity, P&L, позиции, ордера
    и alerts.

7.  **Markets** --- рынки, watchlists, screener и быстрый переход к
    графику.

8.  **Terminal** --- основной торговый экран с графиком, стаканом, order
    ticket и позициями.

9.  **Signals** --- входящие внешние сигналы, их статус, parsed payload
    и история.

10. **Bots & Automations** --- bounded automation, DCA, Grid, webhook
    workflows и шаблоны.

11. **Orders** --- активные, исполненные, отменённые и отклонённые
    ордера.

12. **Positions** --- открытые позиции, risk, P&L, TP/SL, trailing и
    history.

13. **Portfolio** --- балансы, equity, allocation, fees и cross-exchange
    view.

14. **Policies** --- risk limits, allowlists, approvals, schedules и
    kill switch.

15. **Journal / Audit** --- полный журнал действий и событий.

16. **Connections** --- биржи, API keys, permissions, health и revoke.

17. **AI Copilot** --- текстовый и голосовой интерфейс.

18. **Settings** --- язык, часовой пояс, уведомления, безопасность,
    billing и data export.

19. **Team** --- workspace members, roles, approvals и activity.

Мобильная версия должна быть ориентирована на мониторинг, подтверждение,
паузу automation и экстренное действие. Создание сложных ботов и
изменение критической policy на мобильном устройстве должно требовать
дополнительного подтверждения.

5\. Главный торговый экран

5.1. Layout

Основной Terminal screen должен поддерживать desktop-first layout:

-   верхняя панель: workspace, account, exchange, symbol, timeframe;

-   центральная область: свечной график;

-   левая панель: drawing tools;

-   правая панель: order ticket, AI/voice trigger, order book и market
    info;

-   нижняя панель: positions, open orders, order history, signals, fills
    и audit events;

-   переключатель [Manual / Signal / Paper / Live]{.underline};

-   явный индикатор окружения: [PAPER]{.underline},
    [TESTNET]{.underline}, [LIVE]{.underline}.

На мобильном устройстве блоки должны превращаться в tabs или bottom
sheets без потери критической информации.

5.2. TradingView-интерфейс и ограничения лицензирования

В продукте нужна привычная логика TradingView-интерфейса, но нельзя без
лицензии копировать или перепродавать закрытые компоненты TradingView.

Варианты реализации:

20. **MVP:** использовать Apache/MIT-совместимую библиотеку вроде
    TradingView Lightweight Charts для свечей, линий, маркеров и базовых
    overlays.

21. **TradingView integration:** принимать TradingView alerts через
    webhook и поддерживать Pine Script-generated payloads.

22. **Licensed integration:** при наличии соответствующей коммерческой
    лицензии подключить TradingView Charting Library или другой
    разрешённый компонент.

23. **Embedded widget:** использовать публичный widget только там, где
    это разрешено условиями TradingView; embedded widget не должен
    автоматически считаться источником исполнения.

В документации и UI нельзя утверждать, что Vektor является частью
TradingView. Нужно говорить [TradingView alert integration]{.underline}
или [TradingView-compatible webhook]{.underline}.

5.3. Свечи и рыночные данные

График должен поддерживать:

-   candlestick;

-   line;

-   area;

-   Heikin Ashi как отдельный режим, если данные и расчёт корректны;

-   объём;

-   базовые bid/ask markers;

-   current price line;

-   last trade marker;

-   real-time updates через WebSocket;

-   исторические данные через REST или data provider;

-   переключение timeframe;

-   timezone пользователя;

-   UTC mode;

-   crosshair;

-   zoom и pan;

-   auto-fit;

-   replay в paper/dry-run режиме;

-   отображение задержки данных и источника котировки.

Timeframes MVP:

-   1m, 3m, 5m, 15m, 30m;

-   1h, 2h, 4h;

-   1D, 1W.

Для каждой свечи должны быть корректно обработаны gaps, timezone,
duplicate timestamps и неполная последняя свеча.

5.4. Индикаторы

MVP:

-   EMA;

-   SMA;

-   VWAP;

-   RSI;

-   MACD;

-   Bollinger Bands;

-   ATR;

-   volume;

-   stochastic.

Следующий этап:

-   пользовательские параметры;

-   несколько экземпляров одного индикатора;

-   сохранение chart layout;

-   versioned indicator configuration;

-   import/export layout;

-   server-side или client-side calculation с одинаковым результатом;

-   визуальное сравнение индикаторов разных timeframe.

Индикатор не должен автоматически считаться торговым сигналом Vektor. Он
только отображает данные или пользовательский расчёт.

5.5. Рисование на графике

Обязательные инструменты:

-   horizontal line;

-   vertical line;

-   trend line;

-   ray;

-   extended line;

-   parallel channel;

-   rectangle;

-   price range;

-   date/time range;

-   long position tool;

-   short position tool;

-   Fibonacci retracement;

-   Fibonacci extension;

-   text label;

-   arrow/marker;

-   measurement tool;

-   magnet mode;

-   lock/hide/delete;

-   undo/redo;

-   save drawing layout;

-   copy layout between symbols;

-   per-user and per-workspace layouts.

Рисунки должны храниться отдельно от ордеров и не должны сами по себе
отправлять операции на биржу. Если пользователь превращает рисунок в
alert condition, приложение обязано показать отдельное подтверждение и
источник условия.

5.6. Отображение текущей цены

На графике обязательно отображать:

-   линию текущей цены;

-   числовое значение;

-   направление последнего движения;

-   время последнего обновления;

-   источник данных;

-   задержку;

-   bid/ask и spread, если доступны;

-   предупреждение [DATA STALE]{.underline}, если данные старше
    допустимого TTL.

5.7. Отображение позиции, ордеров, тейков и стопов

Для каждой открытой позиции на графике нужно показывать:

-   entry price;

-   average entry price;

-   current price;

-   liquidation price, если это futures и биржа предоставляет значение;

-   break-even price;

-   unrealized P&L;

-   realized P&L;

-   position size;

-   leverage;

-   margin mode;

-   side: long/short;

-   TP levels;

-   SL level;

-   trailing activation and current trailing level;

-   orders pending execution;

-   filled entry/exit markers;

-   partial close markers;

-   DCA/safety-order levels;

-   signal source marker;

-   policy block marker, если действие было заблокировано.

Каждая линия должна иметь tooltip:

> BTCUSDT
>
> Long
>
> Average entry: 62,000 USDT
>
> Current: 62,450 USDT
>
> Unrealized P&L: +2.17%
>
> TP1: 63,000 --- 25%
>
> TP2: 64,000 --- 35%
>
> TP3: 65,000 --- 40%
>
> SL: 60,900
>
> Source: TradingView webhook
>
> Policy: approved

Цвета не должны быть единственным способом передачи информации. Нужны
подписи, иконки и доступность для пользователей с нарушением цветового
зрения.

6\. Ручная торговля

6.1. Order ticket

Order ticket должен поддерживать:

-   market;

-   limit;

-   stop-market;

-   stop-limit;

-   take-profit-market;

-   take-profit-limit;

-   trailing stop, если поддерживается биржей;

-   post-only;

-   reduce-only;

-   close position;

-   close all;

-   close percentage;

-   reverse position;

-   hedge/one-way mode awareness;

-   time-in-force: GTC, IOC, FOK, GTX там, где поддерживается;

-   quantity in base asset;

-   notional in quote asset;

-   percentage of free balance;

-   percentage of equity;

-   risk-based sizing;

-   fixed amount;

-   leverage display;

-   margin mode;

-   estimated fee;

-   estimated slippage;

-   minimum notional;

-   tick size;

-   step size;

-   available balance;

-   required margin;

-   confirmation preview.

6.2. Предторговая проверка

До отправки необходимо проверить:

-   символ существует на выбранной площадке;

-   рынок открыт и не находится в maintenance;

-   тип ордера поддерживается;

-   quantity соответствует step size;

-   price соответствует tick size;

-   notional выше минимального;

-   баланс и margin достаточны;

-   leverage разрешён;

-   position mode совместим;

-   reduce-only не приведёт к ошибочному открытию;

-   TP/SL совместимы с направлением позиции;

-   цена не устарела;

-   сигнал не истёк;

-   operation не является дубликатом;

-   policy разрешает действие;

-   API permissions достаточны.

При ошибке показывать не общий текст [Order failed]{.underline}, а код и
понятное объяснение:

> Операция заблокирована до отправки.
>
> Причина: минимальный размер ордера на Bybit --- 0.001 BTC.
>
> Распознано: 0.0004 BTC.
>
> Предлагаемое действие: изменить размер или выбрать другую площадку.

7\. TP, SL, partial close, trailing и position management

7.1. Take Profit

Поддержать:

-   один или несколько TP;

-   фиксированная цена;

-   процент от entry;

-   процент от текущей цены;

-   R-multiple;

-   процент закрываемой позиции на каждом уровне;

-   reduce-only;

-   cancel remaining targets;

-   move stop after target;

-   market или limit exit там, где поддерживается;

-   визуальное отображение каждой цели.

Пример:

> {
>
> \"targets\": \[
>
> {\"price\": 63000, \"close_percent\": 25},
>
> {\"price\": 64000, \"close_percent\": 35},
>
> {\"price\": 65000, \"close_percent\": 40}
>
> \]
>
> }

7.2. Stop Loss

Поддержать:

-   stop-market;

-   stop-limit;

-   фиксированная цена;

-   процент от entry;

-   ATR-based distance как пользовательская настройка;

-   SL по риску позиции;

-   reduce-only;

-   stop trigger source;

-   отображение trigger price и limit price отдельно;

-   предупреждение при отсутствии биржевого защитного ордера.

Если защита существует только в серверной логике Vektor, UI должен явно
написать:

Этот стоп зависит от доступности Vektor. Для более устойчивой защиты
разместите stop order непосредственно на бирже, если это поддерживается.

7.3. Break-even

Поддержать:

-   перенос SL в entry;

-   перенос SL в entry плюс fees;

-   перенос после TP1;

-   перенос после заданного процента движения;

-   перенос после заданного R-multiple;

-   настройку offset;

-   preview того, какой ордер будет отменён и создан.

7.4. Trailing

Поддержать:

-   trailing distance в процентах;

-   trailing distance в абсолютной цене;

-   activation price;

-   callback rate, если поддерживает биржа;

-   server-side и exchange-side trailing с явным указанием режима;

-   отображение текущего trailing уровня;

-   pause/resume;

-   журнал каждого изменения trailing.

7.5. Частичное закрытие

Поддержать:

-   закрытие фиксированного количества;

-   закрытие процента позиции;

-   закрытие по TP;

-   ручное partial close;

-   закрытие по внешнему сигналу;

-   корректное обновление TP/SL после уменьшения позиции;

-   запрет отрицательного размера;

-   reconciliation после частичного fill.

8\. DCA, averaging, Grid и automation

Эти функции должны быть реализованы как отдельные bounded workflows, а
не как автономный AI-трейдер.

8.1. DCA / averaging

Поддержать:

-   старт по внешнему сигналу;

-   базовый entry;

-   safety orders;

-   расстояние между ордерами в процентах или фиксированной цене;

-   геометрическое увеличение расстояния;

-   fixed или multiplier size;

-   максимум safety orders;

-   общий max notional;

-   пересчёт average entry;

-   новые TP/SL после усреднения;

-   пауза и отмена workflow;

-   журнал каждого шага.

8.2. Grid

Опциональный post-MVP модуль:

-   верхняя и нижняя граница;

-   число уровней;

-   геометрическая/арифметическая сетка;

-   размер на уровень;

-   stop condition;

-   max exposure;

-   paper simulation;

-   pause/resume;

-   визуальные grid levels.

Не заявлять, что Grid гарантирует доходность.

8.3. Conditional workflows

Поддержать условия:

-   price;

-   indicator value;

-   time window;

-   external signal;

-   account exposure;

-   API health;

-   market status;

-   funding rate, если доступен;

-   spread/slippage threshold;

-   manual approval.

Условия должны быть versioned и воспроизводимыми.

9\. Внешние сигналы и signal-to-order

9.1. Источники

MVP:

-   TradingView webhook;

-   generic HTTPS webhook;

-   ручной ввод;

-   текстовый AI parser;

-   Telegram через официально разрешённую интеграцию или controlled bot
    bridge.

Post-MVP:

-   Discord;

-   email parser;

-   Slack;

-   API/MCP;

-   внешние боты;

-   собственный signal provider workspace.

9.2. Каноническая схема сигнала

> {
>
> \"schema_version\": \"1.0\",
>
> \"signal_id\": \"provider-2026-000123\",
>
> \"source\": {
>
> \"type\": \"tradingview\",
>
> \"provider_id\": \"example-provider\",
>
> \"message_id\": \"optional-id\",
>
> \"received_at\": \"2026-11-22T10:00:00Z\",
>
> \"raw_text\": \"BUY BTCUSDT at market, risk 1%\"
>
> },
>
> \"intent\": {
>
> \"action\": \"open\",
>
> \"symbol\": \"BTCUSDT\",
>
> \"side\": \"long\",
>
> \"order_type\": \"market\",
>
> \"quantity\": null,
>
> \"notional\": null,
>
> \"risk_percent\": 1,
>
> \"price\": null,
>
> \"leverage\": null,
>
> \"time_in_force\": null,
>
> \"reduce_only\": false,
>
> \"hedge_mode\": null
>
> },
>
> \"position_management\": {
>
> \"take_profits\": \[\],
>
> \"stop_loss\": null,
>
> \"trailing\": null,
>
> \"break_even\": null,
>
> \"dca\": null
>
> },
>
> \"routing\": {
>
> \"allowed_venues\": \[\"binance\", \"bybit\"\],
>
> \"preferred_venue\": \"binance\",
>
> \"fallback_allowed\": false
>
> },
>
> \"validity\": {
>
> \"expires_at\": \"2026-11-22T10:05:00Z\",
>
> \"deduplication_key\": \"provider-2026-000123\"
>
> }
>
> }

9.3. Сигнал не должен исполняться молча

Если не хватает критического поля, система должна:

-   запросить уточнение;

-   использовать только заранее заданный пользовательский default;

-   заблокировать действие;

-   записать reason code.

Пример:

В сигнале указано [BUY BTC]{.underline}, но не указан размер. Ваш policy
разрешает считать размер как 2% свободного USDT? \[Подтвердить\]
\[Изменить\] \[Отклонить\]

9.4. Signal processing states

Каждый сигнал имеет состояние:

[received → parsed → normalized → preflighted → awaiting_approval →
approved → submitted → partially_filled → filled → managed →
closed]{.underline}

Альтернативные terminal states:

-   rejected;

-   expired;

-   duplicate;

-   policy_blocked;

-   unsupported;

-   connector_error;

-   cancelled;

-   reconciliation_required.

9.5. Дедупликация и TTL

Один [signal_id]{.underline} не должен повторно открыть позицию без
явного разрешения.

Нужны:

-   deduplication key;

-   provider message ID;

-   hash исходного payload;

-   received timestamp;

-   expiry/TTL;

-   replay protection;

-   журнал повторной доставки;

-   безопасные retries без duplicate order.

10\. Telegram и внешние сигнальные боты

Целевой сценарий:

24. Пользователь имеет платную подписку на внешний signal provider.

25. Provider публикует сигнал в Telegram, webhook или TradingView.

26. Vektor получает сообщение.

27. Vektor сохраняет оригинал.

28. Parser извлекает symbol, direction, entry, order type, size, TP, SL
    и другие поля.

29. Validator проверяет биржу и технические ограничения.

30. Policy engine проверяет лимиты пользователя.

31. Пользователь подтверждает сигнал либо включается bounded
    auto-execution.

32. Vektor отправляет ордер.

33. Все дальнейшие изменения позиции отображаются на графике и в
    журнале.

Нельзя обещать, что Vektor сможет прочитать любой Telegram-канал.
Реализация зависит от прав Telegram Bot API, доступа пользователя к
каналу, формата сообщений и законности автоматизированного
чтения/исполнения.

Нужно поддержать:

-   template-based parser;

-   custom regex/field mapping;

-   AI fallback parser;

-   preview перед применением нового parser template;

-   confidence-independent confirmation для критических полей;

-   versioned parser;

-   примеры исходного сообщения и normalized result;

-   тестовое сообщение;

-   delivery logs;

-   блокировку prompt injection из внешнего текста.

Внешний signal provider может иметь собственную оплату. Vektor не должен
включать стоимость provider в собственную подписку и не должен выдавать
чужие сигналы за свои.

11\. AI Copilot

11.1. Режимы доступа

Read-only assistant

Может:

-   показать позиции;

-   найти сделки без SL;

-   объяснить P&L;

-   найти отклонённые сигналы;

-   сравнить fees и execution quality;

-   показать health коннекторов;

-   объяснить значение ошибки.

Draft assistant

Может подготовить:

-   order draft;

-   policy draft;

-   parser template;

-   chart layout;

-   alert rule;

-   DCA workflow.

Нельзя сохранять или активировать draft без явного подтверждения.

Execution copilot

Может подготовить действие и запросить подтверждение. Это основной
AI-режим MVP.

Bounded executor

Может автоматически исполнять только действия в рамках заранее
сохранённой policy:

-   allowlisted source;

-   allowlisted venues;

-   allowlisted symbols;

-   max notional;

-   max leverage;

-   allowed order types;

-   time window;

-   max exposure;

-   mandatory exchange-side protection;

-   kill switch.

Полностью автономный unrestricted agent не входит в MVP.

11.2. Примеры команд

> Покажи позиции без стоп-лосса.
>
> Подготовь лимитную покупку BTCUSDT на 500 USDT по цене 62000, но не
> отправляй.
>
> Сравни стоимость исполнения ETHUSDT на Binance, Bybit и OKX.
>
> Поставь стоп-лосс на 2% ниже средней цены входа и покажи preview.
>
> Покажи все сигналы за сегодня, которые были заблокированы policy.
>
> Создай parser для сообщений формата: BTCUSDT LONG Entry 62000 SL 60000
> TP 65000.

11.3. Обязательная карточка подтверждения

Перед операцией показать:

-   исходный текст;

-   распознанное намерение;

-   биржу;

-   аккаунт;

-   рынок;

-   symbol;

-   side;

-   order type;

-   size/notional;

-   entry price;

-   leverage;

-   TP;

-   SL;

-   trailing;

-   estimated fees;

-   estimated slippage;

-   policy result;

-   source;

-   signal age;

-   expiry/TTL;

-   expected API permissions;

-   кнопку Confirm / Edit / Reject.

Для опасных действий повторить голосом или текстом критические
параметры.

12\. Голосовое управление

12.1. Общие требования

Голос включается только через:

-   push-to-talk;

-   явную кнопку микрофона;

-   системное разрешение.

Постоянное фоновое прослушивание не использовать в MVP.

12.2. Голосовой pipeline

> microphone
>
> → speech-to-text
>
> → language detection
>
> → intent extraction
>
> → canonical command
>
> → policy/preflight
>
> → visual preview
>
> → explicit confirmation
>
> → execution

Всегда отображать распознанный текст до исполнения.

12.3. Мультиязычность

Минимальные языки:

-   русский;

-   английский;

-   китайский;

-   грузинский;

-   армянский;

-   французский;

-   испанский;

-   арабский;

-   португальский.

Для формулировки «языки Конго» нужно выбрать конкретные локали, например
французский, Lingala или Kikongo, а не создавать несуществующую локаль
[congo]{.underline}.

Нужно поддерживать:

-   независимый язык UI;

-   независимый язык голосового ввода;

-   независимый язык ответа AI;

-   code-switching;

-   тикеры и API payload без перевода;

-   RTL;

-   decimal separator;

-   часовые пояса;

-   локализованные ошибки;

-   ICU MessageFormat;

-   fallback на английский;

-   оригинал внешнего сигнала рядом с переводом/нормализацией.

Никаких hardcoded UI strings. Все строки --- через translation keys.

12.4. Голосовые safety checks

Особенно проверять:

-   [0.1%]{.underline} против [1%]{.underline};

-   [BTC]{.underline} против похожего тикера;

-   [10]{.underline} минут против [10]{.underline} часов;

-   long против short;

-   market против limit;

-   quantity против notional;

-   isolated против cross;

-   включение/отключение SL;

-   символы и десятичные значения.

Если распознавание ненадёжно, система должна перейти к текстовому
подтверждению и не отправлять действие.

13\. Risk policy engine

Policy должна быть отдельным детерминированным сервисом, а не prompt
внутри LLM.

Поддержать правила:

-   allowed venues;

-   allowed accounts;

-   allowed symbols;

-   allowed sides;

-   allowed markets;

-   allowed order types;

-   max order notional;

-   max daily notional;

-   max daily loss;

-   max leverage;

-   max open exposure;

-   max exposure per asset;

-   max number of open positions;

-   max consecutive losses;

-   cooldown after close;

-   trading schedule;

-   minimum signal freshness;

-   maximum slippage;

-   maximum spread;

-   minimum liquidity;

-   required SL;

-   required exchange-side protection;

-   approval threshold;

-   separate limits for manual, AI, webhook and Telegram sources;

-   kill switch;

-   connector health requirement;

-   stale data block;

-   IP/API permission requirement.

Изменение policy требует:

-   повторной аутентификации;

-   показа diff;

-   версии policy;

-   имени изменившего пользователя;

-   времени;

-   audit event;

-   для Team --- approval другого участника.

14\. Подключения к биржам

14.1. Приоритет коннекторов

Рекомендуемый порядок:

34. Binance;

35. Bybit;

36. OKX;

37. Kraken;

38. Coinbase Advanced;

39. другие площадки после подтверждения спроса.

Не заявлять «поддерживается биржа», пока нет:

-   sandbox/testnet test;

-   authentication test;

-   market-data test;

-   order placement test;

-   cancel test;

-   partial fill test;

-   TP/SL test;

-   error mapping;

-   rate-limit test;

-   reconnect test;

-   reconciliation test.

14.2. Capability matrix

Для каждой биржи хранить machine-readable capabilities:

> {
>
> \"venue\": \"bybit\",
>
> \"markets\": \[\"spot\", \"linear\", \"inverse\"\],
>
> \"order_types\": \[\"market\", \"limit\", \"stop_market\",
> \"stop_limit\"\],
>
> \"supports_exchange_side_tp_sl\": true,
>
> \"supports_trailing\": true,
>
> \"supports_hedge_mode\": true,
>
> \"supports_reduce_only\": true,
>
> \"supports_partial_close\": true,
>
> \"supports_testnet\": true,
>
> \"supports_websocket_orders\": false,
>
> \"price_precision\": \"dynamic\",
>
> \"quantity_precision\": \"dynamic\"
>
> }

Нельзя использовать один общий набор возможностей для всех бирж.

14.3. Connection health

Показывать:

-   last successful REST call;

-   last WebSocket message;

-   ping/latency;

-   authentication status;

-   permission status;

-   rate-limit state;

-   current incident;

-   reconnect count;

-   stale-data state;

-   clock drift;

-   last reconciliation.

15\. График и execution observability

Для каждой операции пользователь должен иметь возможность открыть
timeline:

> 10:00:00.120 --- signal received
>
> 10:00:00.135 --- payload parsed
>
> 10:00:00.140 --- symbol normalized to BTCUSDT
>
> 10:00:00.151 --- policy approved
>
> 10:00:00.166 --- preflight passed
>
> 10:00:00.190 --- order submitted
>
> 10:00:00.410 --- exchange acknowledged
>
> 10:00:00.612 --- first fill
>
> 10:00:00.900 --- fully filled

Метрики:

-   time-to-parse;

-   decision latency;

-   decision-to-submit;

-   exchange acknowledgement latency;

-   fill latency;

-   fill ratio;

-   rejected orders;

-   cancelled orders;

-   slippage;

-   spread at decision;

-   realized fee;

-   funding/borrow cost;

-   connector downtime;

-   retry count;

-   duplicate prevention;

-   reconciliation status.

На графике должна быть связь между:

-   внешним сигналом;

-   местом входа;

-   фактическими fills;

-   TP/SL;

-   partial close;

-   trailing changes;

-   final close;

-   P&L.

16\. Исторический parity-блок Finandy

16.1. Важное ограничение

Finandy окончательно прекратила работу 10 сентября 2026 года. Поэтому
Vektor не должен утверждать, что он «официально совместим с Finandy»,
если не будет отдельно реализован и протестирован legacy parser.

Исторические функции ниже собраны по публичному уведомлению Finandy и
независимым описаниям продукта. Часть деталей требует архивной проверки
и должна быть реализована как [Finandy compatibility layer]{.underline},
а не как безусловно подтверждённая спецификация.

Источники:

-   [Официальное уведомление Finandy о закрытии](https://finandy.com/)

-   [Историческое описание Finandy и сравнение
    альтернатив](https://cryptomarkets.tools/alternatives/finandy)

-   [Описание закрытия и миграции
    Finandy](https://algovesta.com/ru/blog/finandy-shut-down-alternative.html)

-   [Архивное описание TradingView/API-функций
    Finandy](https://webcatalog.io/en/apps/finandy)

16.2. Исторически подтверждённый или вероятный функциональный набор

Биржи и аккаунты

-   Binance;

-   OKX;

-   Bybit;

-   API-подключение к внешним биржевым аккаунтам;

-   manual terminal;

-   spot и futures в зависимости от биржи;

-   brokerage/copy-trading направление, закрытое до полного shutdown.

Manual position management

-   открытие и закрытие позиций;

-   несколько TP;

-   частичное закрытие;

-   stop-loss;

-   trailing stop;

-   перенос SL в break-even;

-   управление уже открытой позицией;

-   position sizing как доля депозита;

-   position sizing как фиксированная сумма;

-   templates для повторного применения настроек;

-   отображение и управление ордерами через API.

Signal execution

-   TradingView alerts;

-   webhook;

-   POST-запросы от собственного сервера или внешнего бота;

-   открытие позиции по сигналу;

-   усреднение/DCA;

-   reverse;

-   hedge;

-   закрытие позиции;

-   изменение настроек стратегии/бота из сигнала;

-   параметры сделки внутри signal payload;

-   пользовательский JSON-формат;

-   автоматическое размещение и сопровождение ордеров.

Position lifecycle

-   signal entry;

-   averaging;

-   TP/SL management;

-   partial exits;

-   trailing;

-   break-even;

-   reverse/hedge;

-   close by signal;

-   continuation until next signal or exit condition.

Distribution and pricing pattern

Исторически API-трейдинг Finandy был бесплатным при определённых
условиях Binance account/referral model. Это не следует копировать в
Vektor без отдельной юридической, коммерческой и regulatory-проверки. У
Vektor не должно быть зависимости от скрытой referral-модели, которая
делает экономику и доступность продукта непрозрачными.

16.3. Что реализовать как Finandy parity в Vektor

Приоритет P0/P1:

-   Finandy-like webhook endpoint;

-   legacy payload adapter;

-   mapping [buy/sell/long/short/open/close/reverse/hedge]{.underline};

-   symbol mapping;

-   fixed size и percent-of-balance sizing;

-   multiple TP;

-   partial close;

-   SL;

-   trailing;

-   break-even;

-   DCA/safety orders;

-   signal TTL;

-   duplicate protection;

-   position state machine;

-   paper mode;

-   test webhook;

-   replay signal;

-   chart markers for signal, entry, TP, SL and close;

-   migration wizard from old webhook URLs;

-   explicit warning that old Finandy automation may have stopped after
    shutdown.

16.4. Что не копировать без проверки

Не переносить автоматически:

-   brokerage/custody;

-   copy trading marketplace;

-   referral-linked free model;

-   Finandy-specific undocumented payload behavior;

-   undocumented exchange workarounds;

-   any claim that a server-side stop remains safe if Vektor is
    unavailable.

17\. API and webhook requirements

17.1. Generic webhook

Endpoint requirements:

-   unique endpoint per workspace/source;

-   secret token or HMAC signature;

-   replay protection;

-   timestamp validation;

-   idempotency key;

-   rate limit;

-   payload size limit;

-   schema validation;

-   IP allowlist optional;

-   delivery log;

-   test mode;

-   dry-run header;

-   versioned schema.

17.2. API surface

Минимальные backend endpoints:

> POST /v1/webhooks/{endpoint_id}
>
> POST /v1/signals/{signal_id}/parse
>
> POST /v1/signals/{signal_id}/approve
>
> POST /v1/signals/{signal_id}/reject
>
> POST /v1/orders/preview
>
> POST /v1/orders/submit
>
> POST /v1/orders/{order_id}/cancel
>
> POST /v1/positions/{position_id}/close
>
> POST /v1/positions/{position_id}/partial-close
>
> POST /v1/positions/{position_id}/set-protection
>
> GET /v1/markets/{venue}/{symbol}
>
> GET /v1/positions
>
> GET /v1/orders
>
> GET /v1/audit-events
>
> GET /v1/connector-health
>
> POST /v1/policies/validate
>
> POST /v1/policies
>
> POST /v1/connections/test
>
> DELETE /v1/connections/{connection_id}

Ни один endpoint live execution не должен принимать необработанный
natural-language prompt как единственный источник параметров. Сначала
создаётся canonical command и policy decision.

18\. Data model

Минимальные сущности:

-   User;

-   Workspace;

-   Membership;

-   Role;

-   Venue;

-   Connection;

-   Account;

-   API permission snapshot;

-   Market;

-   Instrument capability;

-   Chart layout;

-   Drawing;

-   Indicator configuration;

-   Signal source;

-   Raw signal;

-   Parsed signal;

-   Canonical command;

-   Policy;

-   Policy version;

-   Order draft;

-   Order;

-   Fill;

-   Position;

-   Protection order;

-   Automation workflow;

-   DCA step;

-   Alert;

-   Execution event;

-   Audit event;

-   Incident;

-   Notification;

-   Billing plan.

Критические event records должны быть append-only или tamper-evident.
Нельзя редактировать исходный signal payload после исполнения.

19\. Security requirements

Обязательные меры:

-   encryption at rest;

-   TLS in transit;

-   secrets never in logs;

-   API keys masked in UI;

-   KMS/HSM или эквивалент;

-   key rotation;

-   revoke flow;

-   no withdrawal permissions;

-   IP allowlist where possible;

-   2FA/passkeys;

-   session expiration;

-   device/session list;

-   RBAC;

-   approval separation;

-   audit log;

-   prompt injection isolation;

-   webhook HMAC;

-   rate limits;

-   replay protection;

-   idempotency;

-   connector circuit breaker;

-   kill switch;

-   incident response procedure;

-   export and deletion controls.

Нужно предусмотреть три режима хранения ключей:

40. cloud encrypted;

41. customer-managed vault;

42. local signer/agent.

MVP может начать с cloud encrypted, но архитектура не должна блокировать
local signer.

20\. Уведомления

Каналы:

-   in-app;

-   email;

-   Telegram;

-   browser push;

-   mobile push;

-   webhook callback.

События:

-   signal received;

-   signal parsed;

-   awaiting approval;

-   policy blocked;

-   order submitted;

-   order filled;

-   partial fill;

-   TP hit;

-   SL hit;

-   trailing updated;

-   connector disconnected;

-   stale data;

-   reconciliation mismatch;

-   API permission changed;

-   kill switch activated;

-   incident started;

-   billing limit reached.

Пользователь должен настраивать severity и quiet hours.

21\. Paper, testnet и live lifecycle

Каждая команда, workflow и connector проходят состояния:

> Draft
>
> → Dry-run
>
> → Paper
>
> → Testnet
>
> → Limited live
>
> → Normal live
>
> → Paused
>
> → Revoked

Перед переходом в live показать checklist:

-   API permissions;

-   withdrawals disabled;

-   allowed venues;

-   max notional;

-   max leverage;

-   policy version;

-   protection orders;

-   kill switch;

-   notification channel;

-   stale data behavior;

-   connector health;

-   reconciliation behavior.

Live execution для нового источника по умолчанию выключен.

22\. MVP-план

MVP 1

Включить:

-   web application;

-   responsive terminal;

-   candlestick chart;

-   current price;

-   positions/orders markers;

-   drawing tools: lines, rays, rectangles, text, long/short position
    tool;

-   manual market/limit order;

-   TP/SL;

-   partial close;

-   paper mode;

-   Binance и Bybit либо Binance и OKX;

-   trade-only API;

-   TradingView webhook;

-   generic webhook;

-   text parser на русском и английском;

-   voice-to-text с preview;

-   policy engine;

-   audit log;

-   kill switch;

-   connector health;

-   CSV/JSON export.

Не включать в MVP:

-   custody;

-   brokerage;

-   copy-trading marketplace;

-   unrestricted autonomous agent;

-   десятки коннекторов;

-   полноценный proprietary backtesting engine;

-   собственные сигналы;

-   обещание win rate;

-   binary-options adapter без отдельного решения и legal review.

MVP 2

-   OKX/Kraken/Coinbase;

-   multi-TP;

-   trailing;

-   break-even;

-   DCA;

-   Finandy legacy adapter;

-   Telegram parser;

-   parser templates;

-   team roles;

-   approval workflow;

-   replay;

-   realistic fees/slippage simulation;

-   local signer;

-   mobile confirmation.

MVP 3

-   Grid;

-   advanced automation;

-   multi-venue routing;

-   execution quality comparison;

-   DEX simulation;

-   DEX execution;

-   API/MCP for external AI clients;

-   white-label/API for teams;

-   enterprise retention and SSO.

23\. Acceptance criteria

Функция считается готовой, если:

-   она работает в paper mode;

-   она имеет capability checks;

-   она не позволяет обойти policy через AI;

-   она отображает понятную ошибку;

-   она пишет audit events;

-   она имеет translation keys;

-   она имеет тесты на русском и английском;

-   критические поля подтверждаются пользователем;

-   нет секретов в логах;

-   есть retry/idempotency behavior;

-   есть reconciliation;

-   есть mobile fallback или честная пометка [desktop only]{.underline}.

Торговый acceptance test

Для каждого коннектора проверить:

43. подключение read/trade-only ключа;

44. отказ ключа с withdrawal permission;

45. получение баланса;

46. получение market metadata;

47. market order в paper/testnet;

48. limit order;

49. cancel;

50. partial fill;

51. TP;

52. SL;

53. trailing;

54. partial close;

55. duplicate webhook;

56. stale signal;

57. unsupported order type;

58. insufficient balance;

59. wrong precision;

60. reconnect;

61. reconciliation;

62. kill switch.

Voice acceptance test

Проверить команды:

-   «Покажи мои позиции»;

-   «Подготовь покупку BTC на 100 USDT»;

-   «Поставь стоп-лосс на 2 процента»;

-   «Закрой половину позиции»;

-   смешанный русский/английский текст;

-   тикеры;

-   десятичные значения;

-   ошибочное распознавание;

-   отказ от подтверждения;

-   голосовую команду с недостаточными параметрами.

24\. Необходимые метрики продукта

Технические:

-   p50/p95 signal-to-decision latency;

-   p50/p95 decision-to-submit latency;

-   connector uptime;

-   WebSocket reconnect rate;

-   exchange rejection rate;

-   preflight accuracy;

-   policy-block rate;

-   duplicate prevention rate;

-   reconciliation accuracy;

-   fill ratio;

-   slippage;

-   stale signal rate;

-   parser clarification rate.

Продуктовые:

-   time-to-first-dry-run;

-   time-to-first-safe-live-order;

-   weekly active workspaces;

-   repeated signal usage;

-   approval conversion;

-   paper-to-live conversion;

-   retention;

-   support minutes per workspace;

-   willingness to pay for governance and execution observability.

Нельзя использовать win rate или P&L как обещание качества Vektor. Можно
показывать фактические пользовательские данные с методологией и
предупреждением, что Vektor не генерирует сигнал.

25\. Pricing hypothesis

Цены --- только гипотеза для тестирования.

Free / Sandbox --- \$0

-   paper/dry-run;

-   один connector;

-   ограниченное число signals;

-   базовые графики;

-   ограниченный audit;

-   без live execution.

Trader --- ориентир \$19--39/month

-   2--3 connectors;

-   live execution;

-   manual order ticket;

-   TP/SL;

-   webhook;

-   text parser;

-   preview;

-   базовые policies;

-   ограниченный voice;

-   журнал.

Pro --- ориентир \$39--79/month

-   5+ connectors;

-   multi-account;

-   advanced TP/SL/trailing/break-even;

-   DCA;

-   advanced chart layouts;

-   execution analytics;

-   Telegram/TradingView adapters;

-   expanded history;

-   priority support.

Team --- ориентир \$99--199/workspace/month

-   roles;

-   approvals;

-   shared policies;

-   audit export;

-   seat management;

-   account/subaccount mapping;

-   incident workflow;

-   longer retention.

Не вводить success fee на MVP. Не продавать сигналы. Не маскировать
биржевые комиссии как комиссии Vektor.

26\. Что Claude не должен делать

Claude не должен:

-   писать код с реальным торговым доступом без paper/testnet режима;

-   использовать withdrawal API permissions;

-   считать, что поддержка одной биржи означает поддержку всех рынков
    этой биржи;

-   отправлять ордер на основании одного неструктурированного
    LLM-ответа;

-   менять policy через natural-language prompt;

-   автоматически заменять неизвестный symbol;

-   скрывать partial fill или rejection;

-   включать постоянное голосовое прослушивание;

-   копировать TradingView proprietary UI без проверки лицензии;

-   использовать copyrighted Finandy/TradingView code;

-   обещать прибыль, win rate или «безопасный трейдинг»;

-   считать внешний signal provider частью Vektor;

-   реализовывать brokerage/custody без отдельного юридического проекта;

-   заявлять полноценный parity с Finandy без legacy test suite;

-   включать autonomous unrestricted agent в первый релиз.

27\. Рекомендуемый порядок работы Claude

63. Сформировать monorepo и описать архитектуру.

64. Создать capability model для бирж.

65. Реализовать mock exchange и paper engine.

66. Реализовать canonical order/signal schema.

67. Создать deterministic policy engine.

68. Создать webhook ingestion и idempotency.

69. Реализовать chart terminal.

70. Добавить отображение current price, entry, TP, SL, fills и P&L.

71. Добавить manual order ticket.

72. Добавить text parser и preview.

73. Добавить voice-to-text без live execution by default.

74. Добавить первый testnet connector.

75. Реализовать reconciliation и audit log.

76. Добавить TradingView webhook adapter.

77. Добавить Finandy legacy adapter после фиксации формата payload.

78. Провести acceptance tests.

79. Только после этого включать ограниченное live execution.

Каждый этап должен заканчиваться:

-   работающим demo;

-   тестами;

-   списком известных ограничений;

-   screenshots или коротким walkthrough;

-   обновлённым changelog;

-   отсутствием неподтверждённых claims.

28\. Итоговое продуктовоe решение

Vektor не должен быть копией Finandy, TradingView или 3Commas. Он должен
взять лучшие полезные сценарии:

-   графики и рисование;

-   ручное управление позициями;

-   TradingView alerts;

-   внешние сигналы;

-   TP/SL;

-   partial close;

-   trailing;

-   break-even;

-   DCA;

-   multi-exchange;

-   paper mode;

-   audit;

-   AI и голос.

Но объединить их вокруг более строгого процесса:

> внешний сигнал или намерение пользователя
>
> → понятная нормализация
>
> → проверка технической исполнимости
>
> → policy engine
>
> → preview
>
> → подтверждение или ограниченное автоматическое действие
>
> → исполнение
>
> → графическое отображение
>
> → reconciliation
>
> → полный audit trail

Главная ценность продукта --- не обещание лучшего сигнала. Это контроль
над тем, **что именно было получено, как оно было понято, почему
действие разрешили или заблокировали, где был исполнен ордер и что
произошло после него**.

Источники исторических функций Finandy

80. [Finandy --- официальное уведомление о прекращении
    работы](https://finandy.com/)

81. [CryptoMarkets.tools --- историческое описание Finandy и
    альтернатив](https://cryptomarkets.tools/alternatives/finandy)

82. [AlgoVesta --- Finandy shutdown и миграционные
    рекомендации](https://algovesta.com/ru/blog/finandy-shut-down-alternative.html)

83. [WebCatalog --- архивное описание
    Finandy](https://webcatalog.io/en/apps/finandy)

84. [TradingView --- официальная документация webhook
    alerts](https://www.tradingview.com/support/solutions/43000529348-how-to-configure-webhook-alerts/)

85. [TradingView --- Pine Script
    documentation](https://www.tradingview.com/pine-script-docs/)

86. [3Commas --- Signal Bot JSON
    Guide](https://help.3commas.io/en/articles/16281112-signal-bot-comprehensive-json-guide)

87. [WunderTrading --- TradingView automated
    trading](https://wundertrading.com/en/tradingview-automated-trading)

88. [Altrady --- Help Center](https://help.altrady.com/en)

Финальное предупреждение для разработки

Это спецификация программного продукта, а не инвестиционная рекомендация
и не гарантия торгового результата. Любая live-функция должна
запускаться после тестирования на paper/testnet, проверки разрешений
API, юридической оценки юрисдикции и подтверждения пользователем.
