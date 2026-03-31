# remote-portalNotify — Documentacao Tecnica

## Visao Geral

Aplicacao Node.js (ES modules) que faz scraping do portal de tickets da Praxio (`portaldocliente.praxio.com.br`), coleta tickets filtrados por cliente ou por busca salva (customSearchMenu), calcula SLA (tempo util em horario comercial) e VOC (tempo corrido desde a ultima atualizacao), e persiste snapshots em PostgreSQL.

O portal usa **DevExpress ASPxGridView** -- um componente server-side que mantem estado no servidor. Cada interacao (filtrar, paginar, ordenar) e um POST AJAX que envia o estado atual do grid e recebe HTML atualizado + novo estado. O scraper replica essa sequencia exata de requests.

Existem dois modos de scraping:

1. **Por cliente** (`fetchAllTickets`) -- Replica 3 steps de filtro no grid DevExpress + paginacao. Aplica limite de data (`MAX_AGE_MONTHS`).
2. **Por busca salva** (`fetchCustomSearchTickets`) -- Usa `customSearchMenu` (filtro pre-configurado no portal) + paginacao. Coleta **todos** os tickets sem limite de data.

---

## Arquivos do Projeto

| Arquivo                                   | Funcao                                                                                                                                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.js`                                | Servidor Express. Rotas HTTP, login, orquestracao geral, cache SLA em memoria (2h TTL), background processing de SLA                                                                  |
| `scraper.js`                              | Scraping paginado de tickets do grid DevExpress (por cliente e por customSearchMenu)                                                                                                  |
| `tramites.js`                             | Busca historico de tramites de um ticket especifico                                                                                                                                   |
| `visualizacoes.js`                        | Busca quem visualizou um ticket especifico                                                                                                                                            |
| `slaCalculator.js`                        | Calculo de SLA (tempo util) e VOC (tempo corrido). Busca tramites de cada ticket, rastreia responsavel via "assumido por"/"transferido para", calcula tempo util em horario comercial |
| `service.js`                              | Upsert e leitura de snapshots SLA/VOC na tabela `sla_snapshots` via PostgreSQL                                                                                                        |
| `ticketNotes.js`                          | CRUD de notas/mensagens internas de tickets. Acessa tabela `TICKETS` via `postgres` (migrado da old-api)                                                                              |
| `db.js`                                   | Conexao PostgreSQL via `DATABASE_URL` (connection string) + `initDB()` que executa migrations pendentes                                                                               |
| `migrate.js`                              | Migration runner. Tabela de controle `_migrations_sla`, executa `.sql` de `migrations/` em ordem                                                                                      |
| `migrations/001_create_sla_snapshots.sql` | Criacao da tabela `sla_snapshots`                                                                                                                                                     |
| `migrations/002_add_status_column.sql`    | Adiciona coluna `status` na tabela `sla_snapshots`                                                                                                                                    |
| `.env`                                    | Variaveis: `DATABASE_URL`, `PORTAL_LOGIN`, `PORTAL_PASSWORD`, `TEAMS_WEBHOOK_URL`, `API_KEY`                                                                                          |

---

## Dependencias

- `axios` + `axios-cookiejar-support` + `tough-cookie` -- HTTP client com cookie jar persistente (sessao autenticada)
- `node-html-parser` -- Parse de HTML retornado pelo portal
- `express` v5 -- Servidor HTTP
- `cors` -- Middleware CORS (permite chamadas cross-origin dos userscripts e do `history.js`)
- `postgres` -- Cliente PostgreSQL
- `dotenv` -- Variaveis de ambiente

---

## Rotas HTTP

### `GET /`

Health check. Retorna `{ message: "Bot esta rodando!" }`.

### `GET /scrape-all/:clientName`

Scraping completo de tickets filtrados por nome do cliente. Aplica limite de data (`MAX_AGE_MONTHS`).

1. Faz login no portal (ate 2 tentativas)
2. Chama `fetchAllTickets(clientName, session, login)`
3. Retorna JSON com array de tickets

Response:

```json
{
  "message": "Scraping concluido para o cliente colibri",
  "client": "colibri",
  "ticketCount": 123,
  "tickets": [
    {
      "number": "123456",
      "title": "Titulo do ticket",
      "opening": "27/03/2026 14:30",
      "lastUpdate": "27/03/2026 15:45",
      "client": "COLIBRI",
      "module": "LUNA",
      "person": "FULANO",
      "responsible": "VITOR.OLIVEIRA"
    }
  ]
}
```

### `GET /scrape-custom/:customSearchMenuId`

Scraping completo de tickets de uma busca salva (customSearchMenu) do portal. **Sem limite de data** -- coleta todos os tickets retornados pela busca.

1. Faz login no portal (ate 2 tentativas)
2. Chama `fetchCustomSearchTickets(customSearchMenuId, session, login)`
3. Retorna JSON com array de tickets

Response:

```json
{
  "message": "Scraping concluido para customSearchMenu=28720",
  "customSearchMenuId": "28720",
  "ticketCount": 45,
  "tickets": [
    {
      "number": "123456",
      "link": "https://portaldocliente.praxio.com.br/Ticket/TicketPrincipal/123456",
      "title": "Titulo do ticket",
      "opening": "27/03/2026 14:30",
      "lastUpdate": "27/03/2026 15:45:33",
      "team": "N1",
      "client": "COLIBRI",
      "module": "LUNA",
      "person": "FULANO",
      "responsible": "VITOR.OLIVEIRA"
    }
  ]
}
```

### `GET /tramites/:ticketId`

Busca tramites (historico de mensagens) de um ticket.

- Query params opcionais: `origin` (filtrar por "operador", "cliente", "privado"), `search` (busca texto)
- Usa rota AJAX interna `/Ticket/TicketTramitesHistorico?idTicket={id}`

### `GET /visualizacoes/:ticketId`

Busca quem visualizou um ticket.

- Usa rota AJAX interna `/Ticket/VisualizadoPor?id_ticket={id}`

### `POST /sla`

Calcula o SLA e VOC de todos os tickets retornados pela busca salva `customSearchMenu=28720` (tickets do time de atendimento N1 + tickets do time de produto). O time de pessoas e parametrizado via body JSON.

**Resposta imediata + processamento em background**: A rota responde instantaneamente com dados ja persistidos no banco (`sla_snapshots`) e dispara o recalculo de SLA em background, sem bloquear a resposta HTTP. Isso evita que o cliente espere ~4 minutos pelo scraping + calculo.

Fluxo:

1. Valida que `team` e um array nao-vazio de strings
2. Verifica cache em memoria (TTL de 2 horas). Se valido, retorna dados cacheados com `cached: true, source: 'memory'`
3. Se cache expirado: busca snapshots do banco via `getSLASnapshots()` e retorna com `cached: true, source: 'database'`
4. Em paralelo, dispara `runSLABackground(team)` (fire-and-forget) que faz login, scraping, calculo e upsert
5. Se banco vazio (primeira execucao absoluta): aguarda o background terminar (ate 10 min) antes de responder
6. O background atualiza o cache em memoria ao concluir, beneficiando requests subsequentes

Body:

```json
{
  "team": ["VITOR.OLIVEIRA", "AURORA.SIMONELLI", "MATHEUS.SANTOS"]
}
```

Response (quando retorna do banco):

```json
{
  "message": "SLA retornado do banco (192 tickets). Recalculo em andamento.",
  "ticketCount": 192,
  "processedAt": "27/03/2026 14:30",
  "team": ["VITOR.OLIVEIRA", "AURORA.SIMONELLI"],
  "cached": true,
  "source": "database",
  "backgroundProcessing": true,
  "tickets": [
    {
      "id": "905528",
      "number": "0326-005932",
      "title": "Titulo do ticket",
      "client": "COLIBRI",
      "module": "ADM",
      "group": "Luna",
      "person": "FULANO",
      "responsible": "VITOR.OLIVEIRA",
      "team": "N1",
      "status": "Em andamento",
      "opening": "27/03/2026 14:30",
      "lastUpdate": "27/03/2026 15:45",
      "slaMinutes": 150.5,
      "slaFormatted": "2h 31min",
      "vocMinutes": 4320.5,
      "vocFormatted": "3d 0h"
    }
  ]
}
```

Campos de cada ticket na resposta:

- `id` -- ID numerico do ticket no portal (extraido do link, ex: `905528`)
- `number` -- Numero formatado do ticket (ex: `0326-005932`)
- `group` -- Grupo de atendimento (ex: "Luna", "Siga-i OPER", "Siga-i ADM")
- `responsible` -- Responsavel atual pelo ticket, extraido de childNodes[8] do grid (ex: "VITOR.OLIVEIRA")
- `slaMinutes` -- Tempo util em minutos (arredondado a 2 casas decimais). `null` em caso de erro.
- `slaFormatted` -- Formato legivel (ex: "2h 31min", "45min", "0min"). "Erro" em caso de falha.
- `vocMinutes` -- Tempo corrido (wall-clock) em minutos desde o ultimo tramite ate agora. `null` se data invalida.
- `vocFormatted` -- VOC em formato legivel (ex: "3d 2h", "5h"). "N/A" se data invalida.

Campos adicionais da resposta (nivel raiz):

- `cached` -- `true` se veio do cache (memoria ou banco), `false` se foi calculado neste request
- `source` -- `'memory'` (cache em memoria), `'database'` (snapshots do banco). Ausente quando `cached: false`
- `cacheExpiresIn` -- Presente quando `source: 'memory'`. Tempo restante do cache (ex: "87min")
- `backgroundProcessing` -- `true` se ha processamento de SLA em andamento

### `GET /sla/status`

Retorna o estado atual do processamento de SLA em background. Util para polling de progresso.

Response:

```json
{
  "backgroundProcessing": true,
  "phase": "calculating",
  "startedAt": "2026-03-27T17:30:00.000Z",
  "lastError": null,
  "cache": {
    "valid": false,
    "lastRun": null,
    "ageMinutes": null,
    "ticketCount": 0
  }
}
```

Campos:

- `phase` -- Fase atual: `'idle'` | `'login'` | `'scraping'` | `'calculating'` | `'persisting'` | `'done'` | `'error'`
- `lastError` -- Mensagem de erro do ultimo processamento (`null` se ok)

### `GET /ticket/:ticket`

Busca todas as notas/mensagens internas associadas a um ticket. Migrado da old-api (originalmente porta 3001).

- `:ticket` -- Numero/identificador do ticket (ex: `"905528"`)
- Retorna array de rows da tabela `TICKETS`

Response:

```json
[
  {
    "id": 1,
    "ticket": "905528",
    "sender": "VITOR.OLIVEIRA",
    "message": "Texto da nota...",
    "created_at": "2026-03-27T14:30:00.000Z"
  }
]
```

### `POST /ticket`

Cria uma nova nota/mensagem em um ticket.

Body:

```json
{
  "ticket": "905528",
  "sender": "VITOR.OLIVEIRA",
  "message": "Texto da nota..."
}
```

Response: a row inserida com `RETURNING *`.

### `GET /alltickets`

Lista todos os ticket IDs que possuem pelo menos uma nota.

Response:

```json
["905528", "905529", "905530"]
```

---

## Cache SLA em Memoria + Background Processing

O `index.js` usa uma estrategia de **resposta imediata + processamento em background** para evitar que o cliente espere ~4 minutos pelo scraping + calculo de SLA:

### Cache em memoria (`slaCache`)

- **TTL**: 2 horas (`CACHE_TTL_MS = 2 * 60 * 60 * 1000`)
- **Inicializacao**: Cache vazio ao iniciar o servidor
- **Comportamento**: Se a ultima execucao bem-sucedida foi ha menos de 2 horas, retorna dados do cache com `source: 'memory'`
- **Invalidacao**: Apenas por tempo (sem invalidacao manual)
- **Escopo**: O cache e global (nao por team)

```js
const slaCache = {
  lastRun: null, // Date da ultima execucao
  response: null, // Objeto JSON retornado na ultima execucao
};
```

### Estado do background (`slaBackground`)

Controla o processamento assincrono de SLA:

```js
const slaBackground = {
  isProcessing: false, // true enquanto o background job esta rodando
  startedAt: null, // Date de inicio
  lastError: null, // mensagem de erro (null se ok)
  phase: "idle", // 'idle'|'login'|'scraping'|'calculating'|'persisting'|'done'|'error'
};
```

### Fluxo de resposta do POST /sla

1. Cache em memoria valido (< 2h) -> retorna imediatamente do cache (`source: 'memory'`)
2. Cache expirado -> busca `sla_snapshots` do banco (`source: 'database'`), dispara background
3. Banco vazio (primeira execucao) -> aguarda background terminar (ate 10 min)

O background (`runSLABackground`) e fire-and-forget: faz login, scraping, calculo, upsert, e atualiza o cache em memoria ao terminar. Nao dispara processamento duplicado (verifica `isProcessing`).

---

## Banco de Dados

### Conexao (`db.js`)

Usa connection string via `DATABASE_URL` do `.env`:

```js
const sql = postgres(process.env.DATABASE_URL);
```

`initDB()` e chamada na inicializacao do servidor (dentro de `app.listen`) e executa todas as migrations pendentes via `runMigrations`.

### Migrations (`migrate.js`)

Sistema manual de migrations com tabela de controle `_migrations_sla` (nome exclusivo para evitar conflitos com outros servicos no mesmo banco).

Fluxo:

1. Garante que `_migrations_sla` existe (`CREATE TABLE IF NOT EXISTS`)
2. Le nomes de migrations ja executadas
3. Le arquivos `.sql` de `migrations/` em ordem alfabetica
4. Filtra pendentes (nao presentes em `_migrations_sla`)
5. Executa cada uma dentro de uma transaction e registra na tabela de controle

### Tabela `sla_snapshots` (`migrations/001_create_sla_snapshots.sql`)

Snapshot por ticket (upsert, uma row por ticket atualizada a cada execucao de `/sla`):

| Coluna          | Tipo                      | Descricao                                   |
| --------------- | ------------------------- | ------------------------------------------- |
| `ticket_id`     | INTEGER PRIMARY KEY       | ID numerico do ticket (extraido da URL)     |
| `number`        | VARCHAR(20) NOT NULL      | Numero formatado (ex: "0326-005932")        |
| `title`         | TEXT                      | Titulo do ticket                            |
| `client`        | VARCHAR(100)              | Cliente                                     |
| `module`        | VARCHAR(50)               | Modulo                                      |
| `group`         | VARCHAR(100)              | Grupo de atendimento                        |
| `person`        | VARCHAR(100)              | Pessoa associada no portal                  |
| `responsible`   | VARCHAR(100)              | Responsavel atual (extraido do grid)        |
| `team`          | VARCHAR(20)               | Equipe (ex: "N1")                           |
| `status`        | VARCHAR(50)               | Status atual do ticket (ex: "Em andamento") |
| `opening`       | TIMESTAMPTZ               | Data de abertura                            |
| `last_update`   | TIMESTAMPTZ               | Data do ultimo tramite                      |
| `sla_minutes`   | NUMERIC(10,2)             | SLA em minutos (tempo util)                 |
| `sla_formatted` | VARCHAR(30)               | SLA formatado (ex: "2h 31min")              |
| `voc_minutes`   | NUMERIC(10,2)             | VOC em minutos (tempo corrido)              |
| `voc_formatted` | VARCHAR(30)               | VOC formatado (ex: "3d 2h")                 |
| `processed_at`  | TIMESTAMPTZ NOT NULL      | Timestamp da execucao de /sla               |
| `created_at`    | TIMESTAMPTZ DEFAULT NOW() | Primeira insercao                           |
| `updated_at`    | TIMESTAMPTZ DEFAULT NOW() | Ultima atualizacao                          |

### Upsert (`service.js`)

`upsertSLASnapshots(tickets, processedAt)`:

- Filtra tickets com `id != null`
- Converte datas BR para `Date` via `parseBRToDate`
- Faz `INSERT ... ON CONFLICT (ticket_id) DO UPDATE` em batches de 50
- Retorna quantidade de tickets persistidos

### Leitura de snapshots (`service.js`)

`getSLASnapshots()`:

- `SELECT * FROM sla_snapshots ORDER BY sla_minutes DESC NULLS LAST`
- Converte colunas snake_case para camelCase (mesmo formato da resposta de `processTicketsSLA`)
- Converte datas TIMESTAMPTZ de volta para formato BR (`dd/mm/yyyy hh:mm`)
- Retorna array vazio se tabela estiver vazia

### Tabela `TICKETS` (pre-existente)

Notas/mensagens internas associadas a tickets. Tabela criada pela old-api (ja existia no banco antes da migracao -- nenhuma migration necessaria).

| Coluna       | Tipo                      | Descricao                      |
| ------------ | ------------------------- | ------------------------------ |
| `id`         | SERIAL PRIMARY KEY        | ID auto-incremento             |
| `ticket`     | VARCHAR                   | Numero/identificador do ticket |
| `sender`     | VARCHAR                   | Quem enviou a nota             |
| `message`    | TEXT                      | Conteudo da nota               |
| `created_at` | TIMESTAMPTZ DEFAULT NOW() | Data de criacao                |

### Ticket Notes (`ticketNotes.js`)

Modulo de acesso a dados para a tabela `TICKETS`. Usa o mesmo `sql` (postgres) de `db.js`:

- `getTicketNotes(ticket)` -- `SELECT * FROM tickets WHERE ticket = $1`
- `createTicketNote(ticket, sender, message)` -- `INSERT INTO tickets (message, sender, ticket) VALUES (...) RETURNING *`
- `getAllTicketIds()` -- `SELECT ticket FROM tickets` + map para array de strings

---

## `index.js` -- Servidor Express

### Middleware

- `express.json()` -- Parse de JSON body
- `cors()` -- Permite requisicoes cross-origin de qualquer dominio. Necessario para o userscript `history.js` que chama `GET /alltickets`, `GET /ticket/:ticket` e `POST /ticket` via `fetch()` (sem GM_xmlhttpRequest)
- **Autenticacao via `API_KEY`** -- Middleware global que protege **todas** as rotas. Verifica o header `Authorization` de cada requisicao contra a variavel `API_KEY` do `.env`. A chave deve ter exatamente 104 caracteres. O servidor nao inicia se `API_KEY` estiver ausente ou com tamanho incorreto.

  Comportamento:
  - Header `Authorization` ausente -> `401 { error: 'Header Authorization ausente' }`
  - Header presente mas diferente de `API_KEY` -> `403 { error: 'Chave de autenticacao invalida' }`
  - Header presente e identico a `API_KEY` -> prossegue para a rota

  Exemplo de requisicao:

  ```
  curl -H "Authorization: <sua-chave-de-104-caracteres>" http://localhost:3210/sla/status
  ```

### Autenticacao

- `login()` -- POST para `/Home/Entrar` com `txtLogin` e `txtSenha` do `.env`. Usa `session` (axios com cookie jar) para manter cookies.
- `attemptLogin(attempt)` -- Wrapper com log. Tenta ate 2 vezes.
- A sessao e compartilhada entre todas as rotas (cookie jar global).

### Inicializacao

Na inicializacao (`app.listen`), o servidor:

1. Executa `initDB()` que roda todas as migrations pendentes
2. Loga as rotas disponiveis no console:
   - `GET /scrape-custom/:customSearchMenuId`
   - `GET /tramites/:ticketId`
   - `GET /visualizacoes/:ticketId`
   - `POST /sla`
   - `GET /sla/status`
   - `GET /ticket/:ticket`
   - `POST /ticket`
   - `GET /alltickets`

---

## Fluxo do Scraper (`scraper.js`)

### Constantes

- `BASE_URL` = `https://portaldocliente.praxio.com.br`
- `FILTER_URL` = `{BASE_URL}/Ticket/ObterListaFiltro` -- endpoint para aplicar/remover filtros
- `PAGINATION_URL` = `{BASE_URL}/Ticket/ObterListaPaginacao` -- endpoint para mudar de pagina
- `PAGE_DELAY_MS` = 2000 -- delay entre requisicoes de paginacao
- `MAX_AGE_MONTHS` = 2 -- `fetchAllTickets` para quando encontra ticket com ultimo tramite mais antigo que 2 meses. **Nao se aplica a `fetchCustomSearchTickets`.**

### Headers obrigatorios (`DX_HEADERS`)

O DevExpress exige headers especiais em toda requisicao de callback:

- `Content-Type: application/x-www-form-urlencoded; charset=UTF-8`
- `X-Requested-With: XMLHttpRequest`
- `Origin` e `Referer` do portal
- `DXCss` -- lista de CSS carregados (fingerprint do client-side)
- `DXScript` -- lista de scripts carregados (fingerprint do client-side)

Se esses headers estiverem errados/ausentes, o servidor rejeita a requisicao.

---

### Funcao: `fetchAllTickets(clientName, session, loginFn)`

Orquestra o fluxo de scraping por cliente com filtros programaticos:

```
GET /Ticket  ->  initializeGridState()
                    |
            setupGridFilters()  (3 POSTs para /ObterListaFiltro)
                    |
            primeira pagina de tickets filtrados
                    |
            loop de paginacao (POSTs para /ObterListaPaginacao com PBN)
                    |
            para quando:
              - lastUpdateDate < dateLimit (MAX_AGE_MONTHS meses atras)
              - keys da pagina sao identicas a anterior (ultima pagina)
              - generalError ou 0 tickets
```

Retorna array de tickets dentro do limite de data.

Tem retry com re-login em caso de sessao expirada (tanto na inicializacao quanto na paginacao).

---

### Funcao: `fetchCustomSearchTickets(customSearchMenuId, session, loginFn)`

Orquestra o fluxo de scraping por busca salva (customSearchMenu), **sem limite de data**:

```
POST /Ticket/indexPartial  (com customSearchmenu={id})
                    |
            primeira pagina de tickets ja filtrados pelo servidor
                    |
            extrair callbackState/customOperationState/keys
                    |
            loop de paginacao (POSTs para /ObterListaPaginacao com PBN)
              - inclui customSearchMenu no body de cada requisicao
                    |
            para quando:
              - keys da pagina sao identicas a anterior (ultima pagina)
              - generalError ou 0 tickets
```

Retorna array de **todos** os tickets da busca salva.

O `customSearchMenu` e um ID numerico que identifica um filtro pre-configurado no portal GUI. O usuario cria esses filtros manualmente no portal e captura o ID da requisicao do browser. Exemplo: `28720` = tickets com time de atendimento N1 + de produto.

Diferencas em relacao ao `fetchAllTickets`:

- Nao faz `GET /Ticket` nem `setupGridFilters` -- o servidor ja aplica os filtros
- Usa `POST /Ticket/indexPartial` para a primeira pagina (nao `GET /Ticket`)
- Nao aplica `MAX_AGE_MONTHS` -- coleta todos os tickets
- O campo `customSearchMenu` e enviado em **toda** requisicao de paginacao (nao so na primeira)

Tem retry com re-login identico ao `fetchAllTickets`.

---

### `initializeGridState(session)`

Faz `GET /Ticket` para carregar a pagina inicial do grid.

Extrai do HTML embutido (via regex):

- `callbackState` -- blob base64 que contem FilterExpression, PageSize, sort state, etc. **Deve ser passado adiante sem modificar.**
- `customOperationState` -- blob base64 com estado customizado da operacao
- `initialKeys` -- array de IDs dos tickets exibidos na pagina inicial

Regex usadas:

```
/callbackState':'([A-Za-z0-9+/=]+)'/
/customOperationState':'([A-Za-z0-9+/=]+)'/
/keys':\[([^\]]*)\]/
```

---

### `extractStateFromResponse(html, stepName)`

Mesma extracao que `initializeGridState`, mas aplicada a resposta HTML de qualquer callback (filtro, paginacao, ou indexPartial). Retorna `{ callbackState, customOperationState, keys }`.

Usada apos cada step para obter o estado atualizado que sera enviado no proximo request.

---

### `setupGridFilters(session, clientName, callbackState, customOperationState, initialKeys)`

Replica a sequencia exata de 3 requests que o browser faz para configurar os filtros do grid. Cada step usa o estado retornado pelo anterior.

#### Step 1 -- Filtro de cliente (FilterRow col7)

- **URL:** `/Ticket/ObterListaFiltro`
- **Comando:** `17|APPLYCOLUMNFILTER1|{70 + clientName.length}|{clientName}`
  - O `70` e um offset interno do DevExpress. O parametro interno = 70 + tamanho do nome do cliente.
- **Extra fields:** `grdTicket$DXFREditorcol7` = clientName, col27 = "Desenvolvimento" (VI=4, DDD$L=4)

#### Step 2 -- Remove filtro GrupoTipo (col27)

- **URL:** `/Ticket/ObterListaFiltro`
- **Comando:** `17|APPLYCOLUMNFILTER2|270|` (valor vazio = limpar filtro)
- **Extra fields:** col7 mantem clientName, col27 e esvaziado, col27$DDDState recebe windowsState especifico

#### Step 3 -- Filtro de Status no header (col23)

- **URL:** `/Ticket/ObterListaFiltro`
- **Comando:** `23|APPLYHEADERCOLUMNFILTER1|{400 + filterValue.length}|{filterValue}`
  - `filterValue` = `["!1","!3","!4","!5","!6","!7","!8"]` (36 chars, entao inner param = 436)
  - O `400` e offset interno do DevExpress para header filters.
- **Extra fields:** col7 mantem clientName, + campos do popup de header filter (`HFSACheckBox`, `HFListBox`, `DXHFPState`)

Apos o Step 3, a resposta ja contem a primeira pagina de tickets filtrados (50 por pagina). O `parseTicketsFromHTML` e chamado nessa resposta.

---

### `buildCallbackArgument(command, currentKeys)`

Monta o `DXCallbackArgument` generico para qualquer comando de callback DevExpress.

Formato:

```
c0:KV|{kvLength};[...ids];FR|2;-1;CR|2;{};GB|{gbLength};{command};
```

- `KV|{len}` -- keys atuais do grid como JSON array (ex: `["12345","12346"]`)
- `FR|2;-1` -- focused row state
- `CR|2;{}` -- custom render state
- `GB|{len}` -- **len = tamanho do command SEM o `;` final** (a funcao adiciona o `;` como delimitador)
- `command` -- NAO deve incluir `;` final, a funcao adiciona

Usado tanto por `executeGridCallback` (filtros) quanto por `buildDXCallbackArgument` (paginacao).

---

### `executeGridCallback(session, url, command, callbackState, customOperationState, currentKeys, extraFields, stepName)`

Funcao generica que executa um step de callback no grid:

1. Monta `DXCallbackArgument` via `buildCallbackArgument`
2. Monta `grdTicket` (grid state) via `buildGridState`
3. Adiciona campos fixos do form via `buildFormFields`
4. Adiciona `extraFields` especificos do step (sobrescrevem campos fixos se necessario)
5. POST para a URL (ObterListaFiltro, ObterListaPaginacao, etc.)
6. Extrai estado da resposta via `extractStateFromResponse`
7. Retorna `{ callbackState, customOperationState, keys, html }`

---

### `buildGridState(callbackState, customOperationState, previousTicketIds)`

Monta o campo `grdTicket` do formulario -- e o estado JSON do grid serializado com `&quot;` no lugar de `"` (encoding DevExpress).

```json
{
  "focusedRow": -1,
  "keys": ["12345", "12346"],
  "resizingState": "{}",
  "callbackState": "<base64>",
  "lastMultiSelectIndex": -1,
  "scrollState": [0, 0],
  "selection": "",
  "customOperationState": "<base64>"
}
```

O `callbackState` e um blob binario base64 que o servidor decodifica para saber qual FilterExpression, PageSize, Sort, etc. aplicar. **Ele nunca e fabricado pelo client -- sempre passado da resposta anterior.**

---

### `buildFormFields()`

Retorna um objeto com ~50 campos fixos do formulario DevExpress. Representam o estado de todos os editores de filtro do grid (dropdowns, date pickers, text inputs).

Campos com data usam `getCurrentVisibleDate()` para gerar a data atual no formato `MM/dd/yyyy`.

O campo `grdTicket$DXPagerBottom$PSP` define o page size como 50 (selectedItemIndexPath="2" = terceira opcao do dropdown de page size).

---

### `buildDXCallbackArgument(previousTicketIds)`

Monta o `DXCallbackArgument` especifico para paginacao.

Usa o comando `12|PAGERONCLICK3|PBN` (Page Button Next) -- sempre avanca uma pagina para frente. Nao precisa de numero de pagina.

Formato identico ao `buildCallbackArgument`, mas com comando fixo de paginacao.

---

### `buildRequestBody(clientName, callbackState, customOperationState, previousTicketIds)`

Monta o body completo de uma requisicao de paginacao para `fetchAllTickets`:

- `DXCallbackName` = `grdTicket`
- `DXCallbackArgument` via `buildDXCallbackArgument`
- `grdTicket` via `buildGridState`
- `grdTicket$DXFREditorcol7` = clientName (mantem o filtro de cliente)
- Todos os campos fixos via `buildFormFields`

---

### `buildCustomSearchRequestBody(customSearchMenuId, callbackState, customOperationState, previousTicketIds)`

Monta o body completo de uma requisicao de paginacao para `fetchCustomSearchTickets`:

- `DXCallbackName` = `grdTicket`
- `DXCallbackArgument` via `buildDXCallbackArgument`
- `grdTicket` via `buildGridState`
- Todos os campos fixos via `buildFormFields`
- `customSearchMenu` = customSearchMenuId (identificador da busca salva)

Diferenca em relacao ao `buildRequestBody`: nao inclui `grdTicket$DXFREditorcol7` (filtro de cliente), mas inclui `customSearchMenu`.

---

### `parseTicketsFromHTML(htmlString)`

Extrai tickets do HTML retornado pelo grid. Cada ticket e uma row com classe `.dxgvDataRow_Metropolis`.

Mapeamento de `childNodes`:
| Index | Campo | Tipo |
|---|---|---|
| 2 | `number` | Numero do ticket (innerText) |
| 2 | `link` | Link direto (extrai de `<a href>` se presente, senao fallback com `innerHTML.slice(33, 39)`) |
| 3 | `title` | Titulo |
| 4 | `status` | Status atual do ticket (ex: "Em andamento", "Pendente cliente", "Ticket aberto") |
| 6 | `lastUpdate` / `lastUpdateDate` | Data do ultimo tramite (dd/mm/yyyy hh:mm ou dd/mm/yyyy hh:mm:ss) |
| 7 | `opening` / `openingDate` | Data de abertura (dd/mm/yyyy hh:mm ou dd/mm/yyyy hh:mm:ss) |
| 8 | `responsible` + `team` | Responsavel e equipe no formato "NOME.SOBRENOME (N1)". Regex `^(.+?)\s*\(.*\)$` extrai `responsible`; `split(' ')` + ultimo elemento extrai `team` |
| 9 | `client` | Cliente (com slice para remover lixo HTML) |
| 10 | `module` | Modulo |
| 12 | `person` | Pessoa associada |
| 14 | `group` | Grupo de atendimento (ex: "Luna", "Siga-i OPER", "Siga-i ADM") |

**Extracao de responsible/team de childNodes[8]**: O texto bruto vem no formato `"VITOR.OLIVEIRA (N1)"`. A regex `^(.+?)\s*\(.*\)$` captura o nome antes do parentese. Se nao ha parentese, o texto inteiro e usado como `responsible`. O `team` e extraido como a ultima palavra apos `split(' ')`, que resulta no conteudo dentro dos parenteses (ex: "(N1)" -> ultimo token apos split = "N1)" -> na pratica o portal sempre inclui parenteses, entao o split pega a parte correta).

**Safe date parsing**: As datas em childNodes[6] e childNodes[7] podem vir como `&nbsp;`, string vazia, ou formato invalido. O parser verifica se o valor e nao-vazio, diferente de `&nbsp;`, e contem `/` antes de chamar `parseBRDate`. Se o parse falhar, o campo `*Date` fica como `null` (o campo string `opening`/`lastUpdate` mantem o valor original).

**Link extraction**: Tenta extrair via `<a href="/Ticket/TicketPrincipal/ID">` primeiro. Se nao encontrar tag `<a>`, faz fallback para `innerHTML.slice(33, 39)`.

---

### `parseBRDate(str)`

Converte data no formato BR para `Date` object. Suporta tanto `hh:mm` quanto `hh:mm:ss`:

```js
"27/03/2026 14:30"    -> new Date("2026-03-27 14:30")
"27/03/2026 14:30:45" -> new Date("2026-03-27 14:30:45")
```

Implementacao via `str.split('/')` + `rest.split(' ')` -- o `time` captura tudo apos o espaco, incluindo segundos se presentes.

---

### Logica de parada por data (apenas `fetchAllTickets`)

Os tickets vem ordenados por data do ultimo tramite, do mais recente para o mais antigo.

O scraper itera ticket a ticket em cada pagina. Quando encontra um com `lastUpdateDate < dateLimit` (MAX_AGE_MONTHS meses atras), ele:

1. Para de adicionar tickets daquela pagina
2. Nao faz mais requisicoes de paginacao
3. Retorna imediatamente os tickets ja coletados

Isso acontece tanto na primeira pagina (resultado dos filtros) quanto nas paginas subsequentes.

**`fetchCustomSearchTickets` NAO aplica essa logica** -- coleta todos os tickets ate a paginacao acabar.

---

### Deteccao de ultima pagina (duplicate-key stop)

Quando o DevExpress recebe PBN na ultima pagina, ele **nao retorna `generalError`** -- retorna a mesma pagina com as mesmas keys. Isso causaria um loop infinito.

Ambas as funcoes (`fetchAllTickets` e `fetchCustomSearchTickets`) detectam isso comparando as keys da nova pagina com as da anterior:

```js
if (newKeys.length > 0 && previousTicketIds.length > 0 &&
    newKeys.length === previousTicketIds.length &&
    newKeys[0] === previousTicketIds[0]) {
    // Mesma pagina -- fim da paginacao
    break;
}
```

---

## `tramites.js`

### `fetchTramites(ticketId, session, loginFn)`

GET AJAX para `/Ticket/TicketTramitesHistorico?idTicket={id}`.

### `parseTramites(html, ticketId)`

Extrai tramites do HTML. Cada tramite e um `div.itemdiv.dialogdiv`:

- **origin**: "operador" (default), "cliente" (`.body-right`), "privado" (`.privado`)
- **date**: `span.blue` dentro de `div.time`
- **author**: `a` dentro de `div.name` (remove sufixo "(Privado)")
- **content/contentHtml**: `div.text.descricao`
- **status**: `div.statusHistorico` (remove prefixo "Status:")

---

## `visualizacoes.js`

### `fetchVisualizacoes(ticketId, session, loginFn)`

GET AJAX para `/Ticket/VisualizadoPor?id_ticket={id}`.

### `parseVisualizacoes(html, ticketId)`

Extrai de `<tbody> <tr>` -> `td[0]` = usuario, `td[1]` = data.

---

## `slaCalculator.js` -- Calculo de SLA e VOC

Modulo que calcula o SLA (tempo util em horario comercial) e VOC (tempo corrido) de tickets com base nos tramites. Exporta `processTicketsSLA` usado pela rota `POST /sla`.

### Conceito de SLA

O SLA mede o tempo util (seg-sex 8h-18h, fuso Sao Paulo) que um ticket ficou com status **"Em andamento"** sob responsabilidade de um membro do time informado. Nao conta tempo fora do horario comercial, fins de semana, nem periodos em que o status e diferente de "Em andamento" (ex: "Pendente cliente", "Ticket aberto").

### Conceito de VOC

O VOC (Voice of Customer) mede o tempo corrido (wall-clock) desde a data do ultimo tramite do ticket (`lastUpdate` do grid) ate o momento da requisicao. Diferente do SLA, o VOC inclui noites, fins de semana e feriados -- e um indicador simples de "quanto tempo o cliente esta esperando".

### Deteccao de Responsavel

O responsavel atual pelo ticket e rastreado via padroes nos tramites privados:

- **Assuncao**: `"Chamado aberto, assumido por NOME.SOBRENOME."` -- define o responsavel inicial
- **Transferencia**: `"Chamado transferido de FULANO para NOME.SOBRENOME."` -- muda o responsavel

Regex usadas (captura `NOME.SOBRENOME` sem o ponto final da frase):

```
/assumido por ([A-Za-z0-9]+(?:\.[A-Za-z0-9]+)*)/i
/transferido de .+ para ([A-Za-z0-9]+(?:\.[A-Za-z0-9]+)*)/i
```

**Fallback para tickets antigos**: Se nenhum tramite contem "assumido por" ou "transferido para" (tickets anteriores a implementacao desse padrao no portal), o `author` do tramite de operador e usado como responsavel. Isso garante que tickets antigos onde o atendente N1 escreveu tramites em "Em andamento" ainda tenham SLA calculado.

### Funcoes

#### `parseBRDateTime(dateString)`

Converte data BR para `Date`. Suporta `hh:mm` e `hh:mm:ss`:

```js
"27/03/2026 14:30"    -> new Date(2026, 2, 27, 14, 30, 0)
"27/03/2026 14:30:45" -> new Date(2026, 2, 27, 14, 30, 45)
```

#### `calculateBusinessTime(startDate, endDate)`

Calcula minutos uteis entre duas datas. Itera dia a dia, considerando apenas seg-sex 8h-18h. Retorna 0 se intervalo invertido ou datas invalidas.

#### `extractOwnerFromContent(content)`

Extrai o nome do responsavel de um tramite via regex. Retorna UPPERCASE ou `null`.

#### `calculateSLA(tramites, teamMembers)`

Logica principal do calculo:

1. **Inverte** os tramites para ordem cronologica (o `parseTramites` retorna do mais recente para o mais antigo)
2. **Percorre sequencialmente** mantendo o `currentOwner` (responsavel atual)
3. Para cada tramite, atualiza o `currentOwner` se ha "assumido por" ou "transferido para"
4. Calcula `effectiveOwner` = `currentOwner` (explicito) ou `author` do operador (fallback)
5. Para cada **intervalo entre dois tramites consecutivos**, conta tempo util se:
   - `status === "Em andamento"`
   - `effectiveOwner` pertence ao `teamMembers`
6. No **ultimo tramite** (mais recente): se "Em andamento" com responsavel do time, conta tempo ate `nowBrazil()` (momento da requisicao)

```
Tramites (ordem cronologica):
  [0] 14:26 | Ticket aberto | cliente   | owner: null -> nao conta
  [1] 14:29 | Em andamento  | operador  | owner: VITOR (assumido) -> conta 14:29->14:29
  [2] 14:29 | Em andamento  | privado   | owner: VITOR -> conta 14:29->20:18
  [3] 20:18 | Em andamento  | operador  | owner: VITOR -> conta 20:18->09:15
  ...
  [N] ultimo | Em andamento | operador  | owner: VITOR -> conta ate agora
```

#### `calculateVOC(lastUpdate)`

Calcula o tempo corrido (wall-clock) desde `lastUpdate` (string BR do grid) ate agora (fuso SP).

- Converte `lastUpdate` via `parseBRDateTime`
- Se data invalida: retorna `{ minutes: null, formatted: 'N/A' }`
- Se diferenca negativa (data futura): retorna `{ minutes: 0, formatted: '0h' }`
- Caso normal: retorna `{ minutes, formatted }` com minutos arredondados a 2 casas decimais
- Usa `formatVOC` para a string legivel (dias e horas, ex: "3d 2h", "5h")

#### `formatSLA(minutes)`

Formata minutos em string legivel:

- `0` -> `"0min"`
- `45` -> `"45min"`
- `150` -> `"2h 30min"`
- `120` -> `"2h"`

#### `formatVOC(minutes)`

Formata minutos em string legivel com dias e horas (usado para VOC que normalmente tem valores altos):

- `0` -> `"0h"`
- `90` -> `"1h"`
- `1500` -> `"1d 1h"`
- `2880` -> `"2d"`

#### `extractTicketId(link)`

Extrai ID numerico da URL do ticket:

```
"https://portaldocliente.praxio.com.br/Ticket/TicketPrincipal/905528" -> "905528"
```

#### `processTicketsSLA(tickets, session, loginFn, teamMembers, concurrency)`

Orquestra o processamento em batch:

1. Divide tickets em batches de `concurrency` (default 5)
2. Para cada batch, processa em paralelo via `Promise.all`:
   - Extrai `ticketId` do link
   - Busca tramites via `fetchTramites`
   - Calcula SLA via `calculateSLA`
   - Calcula VOC via `calculateVOC`
3. Delay de 2s entre batches
4. Se um ticket falha, retorna `slaMinutes: null, slaFormatted: "Erro"` (nao interrompe os demais). O VOC ainda e calculado mesmo em caso de erro no SLA.
5. Cada ticket no resultado inclui `responsible` (propagado do objeto ticket do scraper)

Retorna array de objetos com dados do ticket + SLA + VOC calculados.

---

## Detalhes Tecnicos do DevExpress ASPxGridView

### Como funciona o callback

O grid mantem estado no servidor. Cada interacao do usuario (filtrar, ordenar, paginar) dispara um POST AJAX:

1. Client envia: `DXCallbackName` (nome do grid), `DXCallbackArgument` (comando), `grdTicket` (estado serializado), + campos do form
2. Server processa, atualiza estado interno, retorna HTML com a tabela atualizada + novo `callbackState` embutido
3. Client extrai novo estado e usa no proximo request

### Endpoints por tipo de operacao

- **Filtros**: POST `/Ticket/ObterListaFiltro`
- **Paginacao**: POST `/Ticket/ObterListaPaginacao`
- **Busca salva (primeira pagina)**: POST `/Ticket/indexPartial` com `customSearchmenu={id}`
- (Ordenacao usaria `/Ticket/ObterListaOrdenacao` mas nao e usada no fluxo atual)

### Formato do DXCallbackArgument

```
c0:KV|{kvLen};[...ids];FR|2;-1;CR|2;{};GB|{gbLen};{command};
```

- `c0:` -- prefixo fixo
- `KV|{len};[...]` -- keys (IDs dos tickets visiveis) como JSON array
- `FR|2;-1` -- focused row (nenhuma)
- `CR|2;{}` -- custom render (vazio)
- `GB|{len};{command};` -- **len e o tamanho do command string SEM o `;` final**. O `;` e delimitador de secao, nao parte do comando.

### Comandos usados

| Comando                                           | Descricao                                | Parametro interno       |
| ------------------------------------------------- | ---------------------------------------- | ----------------------- |
| `17\|APPLYCOLUMNFILTER1\|{70+len}\|{value}`       | Aplica filtro na FilterRow de uma coluna | 70 + tamanho do valor   |
| `17\|APPLYCOLUMNFILTER2\|270\|`                   | Limpa filtro de uma coluna               | 270 (fixo, valor vazio) |
| `23\|APPLYHEADERCOLUMNFILTER1\|{400+len}\|{json}` | Aplica header filter (popup de checkbox) | 400 + tamanho do JSON   |
| `12\|PAGERONCLICK3\|PBN`                          | Page Button Next (proxima pagina)        | --                      |

### Encoding do campo grdTicket

O JSON do grid state usa `&quot;` no lugar de `"` -- isso e exigido pelo DevExpress e a serializacao e feita via `JSON.stringify().replace(/"/g, '&quot;')`.

### Page size

Configurado via `grdTicket$DXPagerBottom$PSP` = `{"selectedItemIndexPath":"2","checkedState":""}` nos form fields fixos. O index "2" corresponde a 50 itens por pagina no dropdown do grid.

### Comportamento na ultima pagina

O DevExpress NAO retorna `generalError` quando PBN e enviado na ultima pagina -- retorna a mesma pagina com keys identicas. O scraper detecta isso comparando `newKeys[0] === previousTicketIds[0]` para evitar loop infinito.
