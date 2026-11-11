# api-konektron-research

API do **Konektron Research**, sistema de cadastro e elaboração de pesquisas científicas (protocolo de pesquisa, revisões de literatura em etapas, triagem e análise de documentos). Implementa a ERS v1.1 (MySQL · Heroku).

## Stack

- Node.js 24 rodando TypeScript direto (remoção de tipos nativa do Node, sem etapa de build)
- Express 5, Zod 4, Knex 3 + mysql2, JWT + bcrypt, Helmet, CORS, rate limit, pino
- MySQL 5.7 / Percona Server 5.7.44 (utf8mb4_unicode_ci) da hospedagem HostGator (cPanel)
- Worker com fila na tabela `fila_tarefa` (importação RIS/BibTeX/CSV/XLSX, PDF com Puppeteer, exportação XLSX com ExcelJS)
- Storage local (desenvolvimento) ou Google Cloud Storage (Heroku)

## Estrutura

```text
src/
├── server.ts / worker.ts / app.ts / routes.ts
├── config/env.ts                 variáveis de ambiente validadas com Zod
├── database/
│   ├── connection.ts             Knex + mysql2 (camelCase ⇄ snake_case, UTC, TINYINT(1) → boolean)
│   ├── migrations/               migração base: aplica o script SQL se o banco estiver vazio
│   ├── seeds/                    dados de teste (seção 7 do script)
│   └── sql/script_banco_pesquisa_mysql.sql
├── middlewares/                  autenticação, papéis no projeto, validação, erros, idempotência
├── modules/                      auth, me, usuarios, catalogos, projetos, protocolo, tipos-revisao,
│                                 revisoes, documentos, triagem, analises, apoio
├── services/                     auditoria, e-mail, notificações, storage, arquivos, fila
├── jobs/                         handlers do worker e leitores de arquivos de busca
├── pdf/                          templates HTML e geração de PDF
├── docs/                         gerador do OpenAPI e rotas /openapi.json e /docs
└── shared/ · utils/ · types/
scripts/                          db-check, db-routines, divisor do script SQL, upload do backup, openapi
bin/                              db-connect.sh (Fixie no Heroku), install-fixie-wrench.sh e backup.sh
docs/openapi.json                 especificação OpenAPI 3.1 gerada (não editar à mão)
tests/                            testes com node:test
.github/workflows/ci.yml          CI: typecheck, lint, testes, OpenAPI em dia e instalador do Fixie
```

## Rodar localmente (Windows)

1. Node 24 (`nvm install 24` ou instalador oficial) e `npm install`.
2. Copie `.env.example` para `.env` e preencha `DB_*` e `JWT_SECRET`.
3. Libere o IP público da sua máquina em **cPanel › Acesso remoto ao banco de dados** e teste com `npm run db:check`.
   Sem internet, suba o banco local: `docker compose up -d` (Percona 5.7) e aponte `DB_HOST=127.0.0.1`.
4. `npm run migrate` cria o banco a partir do script SQL (se já importou pelo phpMyAdmin, só registra a migração).
5. `npm run seed` carrega os dados de teste (senha `Teste@2026`; administrador `admin@konektron.com.br` / `Admin@2026`).
6. Opcional: `npm run db:routines` cria funções e gatilhos (pode falhar com #1419 na hospedagem compartilhada; a API já aplica essas regras).
7. `npm run dev` (API em http://localhost:3333/api/v1) e, em outro terminal, `npm run dev:worker`.
   Para os PDFs, defina `CHROME_PATH` com o caminho do Chrome instalado.

Comandos: `npm test` · `npm run typecheck` · `npm run lint` · `npm run format` · `npm run docs:openapi`.

## Rotas (prefixo `/api/v1`)

Documentação interativa (Swagger UI) em **`/api/v1/docs`** e especificação OpenAPI 3.1 em `/api/v1/openapi.json` (ambas públicas).

O `docs/openapi.json` é **gerado** a partir do roteador do Express e dos schemas Zod do `validate()` (corpo, query e parâmetros), além dos middlewares de autenticação, papéis e upload. Ao criar ou alterar uma rota, rode `npm run docs:openapi` e faça commit do arquivo; o CI (`npm run docs:check`) falha se ele estiver desatualizado. Nos CRUDs montados sob `/projetos/:id`, o id do item aparece como `{itemId}` (o OpenAPI não aceita dois `{id}` no mesmo caminho); na URL real é só a posição.

Autenticação com `Authorization: Bearer <accessToken>`. Erros no formato `{ "erro": { "codigo", "mensagem", "campos" } }`.

| Grupo | Rotas principais | ERS |
| --- | --- | --- |
| Autenticação | `POST /auth/registrar`, `/auth/confirmar-email`, `/auth/login`, `/auth/refresh`, `/auth/logout`, `/auth/esqueci-senha`, `/auth/redefinir-senha` | RF01, RF02 |
| Perfil | `GET/PATCH /me`, `GET /me/plano`, `PUT /me/senha`, `GET /me/dados`, `DELETE /me` (LGPD) | RF04, RNF07 |
| Administração | `GET /admin/usuarios`, `PATCH /admin/usuarios/:id` | RF03 |
| Catálogos | `/bases-dados`, `/idiomas`, `/tipos-documento`, `/diretrizes`, `/checklists`, `/checklists/:id/itens` | RF19, RF20, UC14 |
| Projetos | `GET/POST /projetos`, `GET/PATCH/DELETE /projetos/:id`, `POST /projetos/:id/restaurar`, `/projetos/:id/membros`, `POST /projetos/convites/aceitar`, `GET /projetos/:id/auditoria` | RF05, RF06, RF44, RN17 |
| Protocolo | `GET/PUT /projetos/:id/protocolo`, `POST .../protocolo/concluir`, `POST .../protocolo/pdf`, `GET .../protocolo/versoes`, `.../versoes/comparar?a=&b=`, `POST .../protocolo/aprovacao` | RF07–RF15 |
| Itens do protocolo | `/projetos/:id/outras-questoes`, `/objetivos`, `/palavras-chave`, `/descritores`, `/strings`, `/criterios`, `/questoes` (CRUD + `PUT .../ordem`), `POST /projetos/:id/questoes/de-outras-questoes` | RF09–RF11 |
| Tipos de revisão | `GET/POST /tipos-revisao`, `GET/PATCH/DELETE /tipos-revisao/:id`, `POST /tipos-revisao/:id/copiar`, `/tipos-revisao/:id/etapas` | RF16–RF18 |
| Revisões | `GET/POST /projetos/:id/revisoes`, `GET/PATCH/DELETE /revisoes/:id`, `PATCH /revisoes/:id/etapas/:etapaId` (INICIAR, CONCLUIR, DISPENSAR, REABRIR), `PUT /revisoes/:id/etapas/ordem` | RF21–RF23 |
| Buscas | `GET/POST /revisoes/:id/buscas` (multipart com `arquivo`), `GET/PATCH/DELETE /buscas/:id` | RF24, RF25 |
| Documentos | `GET/POST /projetos/:id/documentos`, `GET/PATCH/DELETE /documentos/:id`, `POST /documentos/:id/referencias`, `POST/GET /documentos/:id/arquivo`, `GET/POST /revisoes/:id/documentos`, `POST /revisoes/:id/duplicados/detectar` | RF26–RF28, RF31, RF34 |
| Triagem | `GET /etapas/:etapaId/documentos`, `PUT /etapas/:etapaId/documentos/:rdId/decisao`, `GET /etapas/:etapaId/conflitos`, `PUT /etapas/:etapaId/conflitos/:rdId` | RF29, RF30 |
| Painel e checklist | `GET /revisoes/:id/painel`, `GET /revisoes/:id/fluxograma?formato=svg`, `GET/PATCH /revisoes/:id/checklist` | RF32, RF33, RF35 |
| Análises | `GET/POST /projetos/:id/analises`, `/analises/:id`, `/analises/:id/documentos`, `PUT /analises/:id/documentos/:docId/respostas`, `/analise-documentos/:id/matriz`, `/analise-documentos/:id/discussao`, `GET /analises/:id/questoes/:qId/comparativo` | RF36–RF40 |
| Relatórios | `POST /analises/:id/exportar`, `POST /projetos/:id/exportar`, `POST /revisoes/:id/relatorio`, `GET /tarefas/:id` | RF41–RF43 |
| Apoio | `/projetos/:id/temas`, `/categorias`, `/comentarios`, `GET /projetos/:id/busca?q=`, `GET /notificacoes`, `POST /notificacoes/lidas`, `POST /sync` | RF45, RF46, ERS 9.4 |
| Planos e cobrança | `GET /planos/assinatura`, `POST /planos/assinar`, `POST /planos/cancelar`, `POST /webhooks/asaas` (público, token do Asaas) | Planos |

## Planos e cobrança (Asaas)

- **Free**: até 3 projetos, 1 membro além do responsável, 500 MB de arquivos. Ao criar o 3º projeto começam 3 meses; no fim, os projetos vão para a lixeira (30 dias) e a conta fica bloqueada até o upgrade (o upgrade devolve os projetos).
- **Standard** (R$ 49,90/mês ou R$ 499/ano): projetos ilimitados, aba Questões, 5 membros, 5 GB.
- **Master** (R$ 99,90/mês ou R$ 999/ano): tudo (Análises, Artigo, TCLE, similaridade e verificação de termos), membros ilimitados, 20 GB. Administradores são sempre Master.
- Opções internas (Administração › Usuários): **vitalício** (o plano não expira nem é cobrado) e **desconto estudantil** (20% no Standard).
- Os recursos de um projeto seguem o plano de quem o criou. Regras em `src/modules/planos/planos.service.ts`.

Cobrança: `POST /planos/assinar` cria o cliente e a assinatura no Asaas (Pix, boleto ou cartão, à escolha na fatura) e devolve o link da fatura. O Asaas avisa o pagamento em `POST /webhooks/asaas`; o evento é gravado em `webhook_evento` (idempotência) e processado no worker. Atraso além de `ASAAS_TOLERANCIA_DIAS` (5) ou assinatura cancelada com o período vencido voltam a conta para o Free.

Configuração: `ASAAS_API_URL` (sandbox ou produção), `ASAAS_API_KEY`, `ASAAS_WEBHOOK_TOKEN` e, com a lista de IPs autorizados ligada no Asaas, `ASAAS_PROXY` (SOCKS de IP fixo; no Heroku, o do Fixie Socks). Depois do deploy, cadastre o webhook com `heroku run npm run asaas:webhook`.

PDFs, importações e exportações rodam no worker: a rota responde `202` com `tarefaId` e o app consulta `GET /tarefas/:id` até `CONCLUIDA`, quando a resposta traz a URL assinada (15 min) do arquivo.

## Papéis

Responsável: tudo no projeto. Colaborador: protocolo, documentos, triagem e análise; não exclui o projeto nem mexe em membros. Orientador: leitura, comentários, aprovação do protocolo e desempate. Leitor: leitura. O administrador tem acesso a tudo.

## Heroku

- App `konektron-research-api` com buildpacks, nesta ordem: `heroku-community/apt` (Aptfile: `mysql-client`), `heroku-community/chrome-for-testing`, `heroku/nodejs`.
- Add-ons: Fixie Socks (IPs fixos, cadastrados no Acesso remoto do cPanel) e Heroku Scheduler (`bash bin/db-connect.sh bash bin/backup.sh` às 06:00 UTC).
- Config Vars: as do `.env.example`, com `DB_HOST=127.0.0.1`, `DB_REMOTE_HOST=<servidor MySQL>`, `STORAGE_DRIVER=gcs` e `NODE_ENV=production`.
- Conexão com o MySQL pelo túnel (sem isso a migração do `release` falha com `ECONNREFUSED 127.0.0.1:3306`):
  1. `heroku addons:create fixie-socks`: cria a Config Var `FIXIE_SOCKS_HOST`.
  2. Cadastre os 2 IPs fixos do Fixie (painel do add-on) em cPanel › **Acesso remoto ao banco de dados**.
  3. `heroku config:set DB_HOST=127.0.0.1 DB_REMOTE_HOST=<servidor MySQL> DB_NAME=... DB_USER=... DB_PASSWORD=...`
  4. Confira com `heroku run bash bin/db-connect.sh npm run db:check`.
  **Não copie os valores do `.env` com aspas**: nas Config Vars as aspas viram parte do valor (uma senha `"abc"` fica com 5 caracteres e o MySQL responde *Access denied*). Não defina `PORT` (o Heroku define) e use um `JWT_SECRET` diferente do de desenvolvimento.
  Enquanto o release command falhar, o app continua no último release bom e `heroku config` mostra as variáveis dele; as novas aparecem em `heroku releases:info` e valem a partir do primeiro release que passar.
  O `bin/db-connect.sh` registra no log (`db-connect: ...`) a abertura do túnel e falha com a causa se `FIXIE_SOCKS_HOST` faltar ou o túnel não abrir.
- `Procfile`: `release` roda as migrações; `web` e `worker` sobem pelo `bin/db-connect.sh`, chamado via `bash` (o Git no Windows não grava o bit de execução dos `.sh`).
- fixie-wrench: o binário **não fica no repositório** (`.gitignore`). O `heroku-postbuild` roda `bin/install-fixie-wrench.sh`, que baixa a versão fixada (v1.0.0, Linux x86_64) do GitHub, confere o SHA-256 e grava `bin/fixie-wrench` com permissão de execução no slug. Fora do Linux x86_64 o script não faz nada. Para atualizar, troque `FIXIE_WRENCH_VERSION` e `FIXIE_WRENCH_SHA256` no script. Não use o `install.sh` oficial no build: ele é interativo e não marca o binário como executável.
- Escala de produção: `heroku ps:scale web=1:standard-1x worker=1:standard-2x`.

## Diferenças em relação à ERS v1.1

- Node 24 executa os `.ts` direto (a ERS citava Node 20 e `dist/`); os comandos do Procfile usam `node src/server.ts` e `node src/worker.ts`.
- Geração de PDF e exportações são assíncronas (`202` + `GET /tarefas/:id`) e usam `POST` em `/protocolo/pdf`, `/analises/:id/exportar`, `/projetos/:id/exportar` e `/revisoes/:id/relatorio`.
- A documentação OpenAPI fica em `/api/v1/docs` (a ERS citava `/docs`), junto do restante da API.
