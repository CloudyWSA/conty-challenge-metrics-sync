# Sincronização de métricas

API em TypeScript com provedor simulado e SQLite. Conecta uma conta, sincroniza posts por janela e mantém o histórico sem somar o mesmo snapshot duas vezes. Os dados ficam em `data/metrics.sqlite` após reiniciar.

## Como rodar

Use Node.js 22.18 ou superior.

```sh
npm ci
npm start
```

A API roda em `http://localhost:3004`. `PORT` troca a porta e `DB_PATH` troca o arquivo SQLite.

```sh
npm test
npm run typecheck
```

## Exemplos

No PowerShell 7, use `curl.exe` no lugar de `curl`. `access_token` é fictício e escolhe o cenário do provedor. Troque `CONNECTION_ID` pelo `id` da primeira resposta.

Conectar uma conta:

```sh
curl -i -X POST http://localhost:3004/connections -H "Content-Type: application/json" -d '{"platform":"instagram","account_id":"criador-1","access_token":"demo"}'
```

Resposta `201`:

```json
{
  "id": "CONNECTION_ID",
  "platform": "instagram",
  "account_id": "criador-1",
  "created_at": "2026-10-09T15:00:00.000Z"
}
```

Conectar novamente a mesma plataforma e conta atualiza o token e retorna `200`, mantendo o mesmo `id`. O token não aparece na resposta.

Sincronizar uma janela:

```sh
curl -i -X POST http://localhost:3004/connections/CONNECTION_ID/sync -H "Content-Type: application/json" -d '{"from":"2026-10-01T00:00:00Z","to":"2026-10-03T00:00:00Z"}'
```

A resposta `200` traz o registro da execução:

```json
{
  "id": "SYNC_ID",
  "connection_id": "CONNECTION_ID",
  "from": "2026-10-01T00:00:00.000Z",
  "to": "2026-10-03T00:00:00.000Z",
  "status": "succeeded",
  "attempts": 1,
  "waited_ms": 0,
  "received": 2,
  "inserted": 2,
  "started_at": "2026-10-09T15:00:00.000Z",
  "finished_at": "2026-10-09T15:00:00.010Z",
  "error": null
}
```

Consultar as métricas atuais:

```sh
curl -i http://localhost:3004/connections/CONNECTION_ID/metrics
```

O resultado contém `posts` em ordem de `post_id`, com `published_at`, `captured_at`, `fetched_at`, `views`, `likes`, `comments` e `shares`, e `totals`. Os totais do exemplo são:

```json
{
  "views": 350,
  "likes": 35,
  "comments": 7,
  "shares": 4
}
```

Sincronizar uma janela que se sobrepõe à anterior:

```sh
curl -i -X POST http://localhost:3004/connections/CONNECTION_ID/sync -H "Content-Type: application/json" -d '{"from":"2026-10-02T00:00:00Z","to":"2026-10-04T00:00:00Z"}'
```

A resposta tem `received: 1` e `inserted: 0`. Os totais continuam iguais. Repetir a primeira janela também não duplica os snapshots.

Consultar o histórico de um post e o registro de uma execução:

```sh
curl -i http://localhost:3004/connections/CONNECTION_ID/posts/post-1/snapshots
curl -i http://localhost:3004/syncs/SYNC_ID
```

O primeiro retorna `snapshots` em ordem de `captured_at`. No segundo, substitua `SYNC_ID` pelo `id` retornado pelo sync.

## Regras

A janela filtra `published_at` no intervalo `[from, to)`, normalizado em UTC. `captured_at` é a data da medição no provedor; `fetched_at` é a hora da primeira coleta desse snapshot pela API.

Um snapshot é único por conexão, post e `captured_at`. Duplicatas não alteram o registro existente. `received` conta o que chegou do provedor, incluindo repetições; `inserted` conta apenas snapshots novos dentro da janela. As métricas são valores absolutos: o total soma o snapshot mais recente de cada post, sem somar o histórico. Uma medição atrasada entra no histórico, mas não substitui a atual. Uma medição realmente mais nova pode corrigir um valor para baixo.

São no máximo 3 tentativas, contando a chamada inicial, com timeout de 1 segundo por chamada. Falhas transitórias usam backoff de 100 e 200 ms. No 429, `Retry-After` pode ser segundos inteiros ou uma data HTTP. Se a espera exceder o saldo, a execução falha sem tentar antes do horário permitido.

O teto de espera é 5 segundos somados entre tentativas. Ele não inclui o tempo das chamadas. Os limites ficam em `defaultPolicy`, em `src/sync.ts`. Ao esgotar as tentativas ou a espera, o sync retorna `503`; uma rejeição definitiva do provedor retorna `502`. O registro da execução continua consultável.

## Provedor simulado

O fake fica isolado em `src/simulated-provider.ts`. Use estes tokens fictícios na conexão:

| Token | Comportamento |
| --- | --- |
| `demo` | Dois posts com métricas fixas. |
| `duplicates` | Repete snapshots na mesma resposta. |
| `timeout-once` | Primeira chamada estoura o timeout. |
| `rate-limit-once` | Primeiro 429 pede espera de 2 segundos; o sync termina com `attempts: 2` e `waited_ms: 2000`. |
| `rate-limit-always` | Todas as chamadas retornam 429 com espera de 2 segundos. |
| `retry-after-too-long` | 429 pede 6 segundos, acima do teto de espera. |
| `unavailable-once` | Primeiro retorno é 503; a tentativa seguinte funciona. |
| `unauthorized` | Retorna 401, sem retry. |

Os cenários `-once` falham uma vez por conexão e token enquanto o processo está rodando. Os posts foram publicados em 1 e 2 de outubro de 2026. Os snapshots têm `captured_at` fixo em `2026-10-09T12:00:00.000Z`, para reproduzir os exemplos. Os testes controlam o relógio e a espera para conferir retries e limites sem depender da hora real.

## O que ficou de fora

Não há autenticação da API nem OAuth real. Com mais tempo, colocaria os syncs em jobs, trataria paginação dos provedores reais e compartilharia o controle de rate limit entre instâncias.

## Uso de IA

Usei o Codex na análise, implementação, testes e documentação. A revisão com IA conferiu as janelas, a deduplicação, os snapshots fora de ordem e os limites de retry.
