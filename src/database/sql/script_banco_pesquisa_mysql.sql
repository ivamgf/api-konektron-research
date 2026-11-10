-- =============================================================================
-- Sistema de Cadastro e Elaboração de Pesquisas Científicas (Konektron Research)
-- Script de criação do banco de dados — MySQL 5.7 / Percona Server 5.7.44
-- Versão 1.1.0 · 05/11/2026
--
-- Servidor de destino (HostGator, cPanel/phpMyAdmin 5.2.3):
--   Percona Server 5.7.44-48 · conexão local por UNIX socket · sem SSL
--   collation de conexão utf8mb4_unicode_ci · motor InnoDB
--
-- Conteúdo:
--   0. Sessão e banco
--   1. Tabelas (45)
--   2. Chaves estrangeiras circulares
--   3. Índices
--   4. Visões do painel de etapas
--   5. Dados iniciais (bases, idiomas, tipos de documento, checklist genérico,
--      diretrizes, tipos de revisão e etapas padrão)
--   6. Usuário administrador
--   7. Dados para teste (opcional — remova esta seção em produção)
--   8. Consultas de verificação
--   9. Rotinas e gatilhos (opcional — exige permissão de criar rotinas)
--
-- Como executar no cPanel:
--   1. cPanel › Bancos de dados MySQL: crie o banco (ex.: <usuario_cpanel>_pesquisa)
--      e o usuário da aplicação (ex.: <usuario_cpanel>_app); adicione o usuário ao
--      banco com SELECT, INSERT, UPDATE, DELETE, EXECUTE (e, para migrações,
--      CREATE, ALTER, DROP, INDEX, REFERENCES, CREATE VIEW, TRIGGER,
--      CREATE ROUTINE, ALTER ROUTINE).
--   2. phpMyAdmin: selecione o banco › Importar › este arquivo (UTF-8).
--      Pela linha de comando:
--      mysql -u <usuario> -p --default-character-set=utf8mb4 <banco> < script_banco_pesquisa_mysql.sql
--
-- Observações do MySQL 5.7 que orientam este script:
--   · CHECK é aceito na sintaxe mas NÃO é aplicado: as regras ficam na API (Zod)
--     e nos gatilhos opcionais da seção 9.
--   · Não há DEFAULT com expressão: a API gera os UUIDs (crypto.randomUUID()) e
--     envia os campos JSON; nos dados deste script usa-se UUID().
--   · Não há CTE recursiva, REGEXP_REPLACE nem SKIP LOCKED.
--   · Se a seção 9 falhar com "#1419 You do not have the SUPER privilege and
--     binary logging is enabled", tudo antes dela já foi criado; a API faz o
--     mesmo trabalho dessas rotinas. Peça ao suporte para ativar
--     log_bin_trust_function_creators se quiser as rotinas no banco.
--
-- Credenciais criadas (TROQUE ANTES DE PRODUÇÃO):
--   Admin  admin@konektron.com.br / Admin@2026      (bcrypt custo 12)
--   Teste  *@example.com / Teste@2026               (seção 7)
-- =============================================================================


-- =============================================================================
-- 0. SESSÃO E BANCO
-- =============================================================================

SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci;
SET time_zone = '+00:00';     -- todas as datas/horas gravadas em UTC
SET SESSION sql_mode = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';

-- Ajusta o banco selecionado (o servidor usa utf8 de 3 bytes por padrão)
ALTER DATABASE CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Para recriar do zero (apaga tudo), descomente o bloco abaixo:
-- SET FOREIGN_KEY_CHECKS = 0;
-- DROP VIEW  IF EXISTS vw_painel_etapas, vw_consultados_por_base;
-- DROP TABLE IF EXISTS fila_tarefa, sync_operacao, auditoria, notificacao, comentario,
--   discussao_item, matriz_sintese_item, resposta, analise_documento, analise_questao, analise,
--   revisao_checklist_item, triagem_resultado, triagem_decisao, revisao_documento, categoria,
--   documento_tema, tema, documento, busca, revisao_etapa, revisao, etapa_modelo, tipo_revisao,
--   diretriz_relato, checklist_item_modelo, checklist_modelo, criterio, questao_analise,
--   string_busca, descritor, palavra_chave, objetivo_especifico, protocolo_outra_questao,
--   artigo, protocolo_versao, protocolo, tipo_documento, idioma, base_dados, convite, projeto_membro,
--   projeto, arquivo, refresh_token, usuario;
-- SET FOREIGN_KEY_CHECKS = 1;


-- =============================================================================
-- 1. TABELAS
-- Convenções: ids UUID em CHAR(36) gerados pela API; datas/horas em
-- DATETIME(3) UTC; "atualizado_em" mantido pelo MySQL (ON UPDATE
-- CURRENT_TIMESTAMP); enumerações em colunas ENUM; listas e objetos em JSON.
-- Todas as tabelas: InnoDB, utf8mb4_unicode_ci, ROW_FORMAT=DYNAMIC (índices
-- de até 3072 bytes).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1.1 Usuários e acesso
-- -----------------------------------------------------------------------------

CREATE TABLE usuario (
  id                    CHAR(36)      NOT NULL,
  nome                  VARCHAR(150)  NOT NULL,
  email                 VARCHAR(255)  NOT NULL,
  senha_hash            VARCHAR(255)  NOT NULL,
  instituicao           VARCHAR(200),
  orcid                 VARCHAR(19)   COMMENT 'formato 0000-0000-0000-000X',
  perfil_global         ENUM('ADMIN','USUARIO') NOT NULL DEFAULT 'USUARIO',
  preferencias          JSON          NOT NULL COMMENT 'objeto; a API grava {} no cadastro',
  ativo                 TINYINT(1)    NOT NULL DEFAULT 1,
  email_verificado_em   DATETIME(3),
  consentimento_lgpd_em DATETIME(3),
  criado_em             DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  atualizado_em         DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC
  COMMENT='Usuários do sistema (RF01–RF04).';

CREATE TABLE refresh_token (
  id           CHAR(36)     NOT NULL,
  usuario_id   CHAR(36)     NOT NULL,
  token_hash   VARCHAR(128) NOT NULL,
  dispositivo  VARCHAR(120),
  expira_em    DATETIME(3)  NOT NULL,
  revogado_em  DATETIME(3),
  criado_em    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  CONSTRAINT fk_refresh_token_usuario FOREIGN KEY (usuario_id) REFERENCES usuario(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC;

-- -----------------------------------------------------------------------------
-- 1.2 Arquivos (storage)
-- -----------------------------------------------------------------------------

CREATE TABLE arquivo (
  id             CHAR(36)        NOT NULL,
  projeto_id     CHAR(36)        COMMENT 'FK adicionada na seção 2',
  provedor       ENUM('LOCAL','GCS','FTP') NOT NULL DEFAULT 'LOCAL',
  chave_storage  VARCHAR(500)    NOT NULL,
  nome_original  VARCHAR(255)    NOT NULL,
  mime_type      VARCHAR(100)    NOT NULL,
  tamanho_bytes  BIGINT UNSIGNED NOT NULL,
  hash_sha256    CHAR(64),
  criado_por     CHAR(36),
  criado_em      DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_arquivo_chave (provedor, chave_storage),
  CONSTRAINT fk_arquivo_criado_por FOREIGN KEY (criado_por) REFERENCES usuario(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC
  COMMENT='Metadados de arquivos no disco do servidor ou no Google Cloud Storage (RN18).';

-- -----------------------------------------------------------------------------
-- 1.3 Projetos
-- -----------------------------------------------------------------------------

CREATE TABLE projeto (
  id             CHAR(36)     NOT NULL,
  titulo         VARCHAR(300) NOT NULL,
  subtitulo      VARCHAR(300),
  area           VARCHAR(150),
  instituicao    VARCHAR(200),
  programa       VARCHAR(200),
  data_inicio    DATE,
  data_fim       DATE         COMMENT '>= data_inicio',
  status         ENUM('ATIVO','ARQUIVADO') NOT NULL DEFAULT 'ATIVO',
  criado_por     CHAR(36)     NOT NULL,
  criado_em      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  atualizado_em  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  excluido_em    DATETIME(3)  COMMENT 'exclusão lógica (RN17)',
  PRIMARY KEY (id),
  CONSTRAINT fk_projeto_criado_por FOREIGN KEY (criado_por) REFERENCES usuario(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC;

CREATE TABLE projeto_membro (
  projeto_id    CHAR(36)    NOT NULL,
  usuario_id    CHAR(36)    NOT NULL,
  papel         ENUM('RESPONSAVEL','COLABORADOR','ORIENTADOR','LEITOR') NOT NULL,
  convidado_em  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  aceito_em     DATETIME(3),
  PRIMARY KEY (projeto_id, usuario_id),
  CONSTRAINT fk_projeto_membro_projeto FOREIGN KEY (projeto_id) REFERENCES projeto(id) ON DELETE CASCADE,
  CONSTRAINT fk_projeto_membro_usuario FOREIGN KEY (usuario_id) REFERENCES usuario(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC;

CREATE TABLE convite (
  id             CHAR(36)     NOT NULL,
  projeto_id     CHAR(36)     NOT NULL,
  email          VARCHAR(255) NOT NULL,
  papel          ENUM('COLABORADOR','ORIENTADOR','LEITOR') NOT NULL COMMENT 'convite nunca é para RESPONSAVEL',
  token_hash     VARCHAR(128) NOT NULL,
  convidado_por  CHAR(36)     NOT NULL,
  expira_em      DATETIME(3)  NOT NULL,
  aceito_em      DATETIME(3),
  criado_em      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  CONSTRAINT fk_convite_projeto FOREIGN KEY (projeto_id) REFERENCES projeto(id) ON DELETE CASCADE,
  CONSTRAINT fk_convite_convidado_por FOREIGN KEY (convidado_por) REFERENCES usuario(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC;

-- -----------------------------------------------------------------------------
-- 1.4 Catálogos
-- -----------------------------------------------------------------------------

CREATE TABLE base_dados (
  id     CHAR(36)     NOT NULL,
  nome   VARCHAR(100) NOT NULL,
  sigla  VARCHAR(30),
  url    VARCHAR(300),
  ativo  TINYINT(1)   NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_base_dados_nome (nome)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC;

CREATE TABLE idioma (
  id      SMALLINT UNSIGNED NOT NULL AUTO_INCREMENT,
  codigo  VARCHAR(10)  NOT NULL COMMENT 'ISO 639-1',
  nome    VARCHAR(50)  NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_idioma_codigo (codigo),
  UNIQUE KEY uq_idioma_nome (nome)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC;

CREATE TABLE tipo_documento (
  id    SMALLINT UNSIGNED NOT NULL AUTO_INCREMENT,
  nome  VARCHAR(60) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_tipo_documento_nome (nome)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC;

-- -----------------------------------------------------------------------------
-- 1.5 Protocolo de pesquisa (aba Definições)
-- -----------------------------------------------------------------------------

CREATE TABLE protocolo (
  id                CHAR(36)    NOT NULL,
  projeto_id        CHAR(36)    NOT NULL COMMENT 'único: RN01',
  status            ENUM('RASCUNHO','CONCLUIDO','APROVADO','DEVOLVIDO') NOT NULL DEFAULT 'RASCUNHO',
  versao_atual      INT UNSIGNED     NOT NULL DEFAULT 0,
  passo_atual       TINYINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '1 a 11 (gatilho aceita até 20)',
  tema              TEXT,
  questao_pesquisa  TEXT,
  hipotese          TEXT,
  objetivo_geral    TEXT,
  justificativa     TEXT,
  metodologia_tipo  VARCHAR(40)  COMMENT 'DSR, QUANTITATIVA, QUALITATIVA, MISTA...',
  metodologia_outro VARCHAR(200) COMMENT 'nome do tipo quando OUTRA',
  metodologia       TEXT         COMMENT 'descrição da abordagem e dos procedimentos',
  riscos            TEXT         COMMENT 'opcional',
  beneficios        TEXT         COMMENT 'opcional',
  resultados_esperados TEXT,
  tcle_arquivo_id   CHAR(36)     COMMENT 'TCLE preenchido (opcional)',
  concluido_em      DATETIME(3),
  aprovado_por      CHAR(36),
  aprovado_em       DATETIME(3),
  parecer           TEXT,
  criado_em         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  atualizado_em     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_protocolo_projeto (projeto_id),
  CONSTRAINT fk_protocolo_projeto FOREIGN KEY (projeto_id) REFERENCES projeto(id) ON DELETE CASCADE,
  CONSTRAINT fk_protocolo_aprovado_por FOREIGN KEY (aprovado_por) REFERENCES usuario(id) ON DELETE SET NULL,
  CONSTRAINT fk_protocolo_tcle FOREIGN KEY (tcle_arquivo_id) REFERENCES arquivo(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC
  COMMENT='Protocolo principal da pesquisa — aba Definições (RF07–RF15).';

CREATE TABLE protocolo_resumo (
  id            CHAR(36)          NOT NULL,
  protocolo_id  CHAR(36)          NOT NULL,
  idioma_id     SMALLINT UNSIGNED NOT NULL,
  texto         TEXT              NOT NULL,
  ordem         INT UNSIGNED      NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_protocolo_resumo_idioma (protocolo_id, idioma_id),
  CONSTRAINT fk_protocolo_resumo_protocolo FOREIGN KEY (protocolo_id) REFERENCES protocolo(id) ON DELETE CASCADE,
  CONSTRAINT fk_protocolo_resumo_idioma FOREIGN KEY (idioma_id) REFERENCES idioma(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC
  COMMENT='Resumo do protocolo por idioma';

CREATE TABLE artigo (
  projeto_id      CHAR(36)     NOT NULL,
  dados           JSON         NOT NULL COMMENT 'rascunho do artigo: textos e escolhas de cada seção',
  atualizado_por  CHAR(36),
  atualizado_em   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (projeto_id),
  CONSTRAINT fk_artigo_projeto FOREIGN KEY (projeto_id) REFERENCES projeto(id) ON DELETE CASCADE,
  CONSTRAINT fk_artigo_atualizado_por FOREIGN KEY (atualizado_por) REFERENCES usuario(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC
  COMMENT='Rascunho do artigo gerado a partir do projeto (um por projeto)';

CREATE TABLE protocolo_versao (
  id              CHAR(36)     NOT NULL,
  protocolo_id    CHAR(36)     NOT NULL,
  versao          INT UNSIGNED NOT NULL COMMENT '>= 1',
  snapshot        JSON         NOT NULL COMMENT 'cópia completa do protocolo na versão',
  justificativa   TEXT         COMMENT 'obrigatória a partir da versão 2 (RN04)',
  pdf_arquivo_id  CHAR(36),
  criado_por      CHAR(36)     NOT NULL,
  criado_em       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_protocolo_versao (protocolo_id, versao),
  CONSTRAINT fk_protocolo_versao_protocolo FOREIGN KEY (protocolo_id) REFERENCES protocolo(id) ON DELETE CASCADE,
  CONSTRAINT fk_protocolo_versao_pdf FOREIGN KEY (pdf_arquivo_id) REFERENCES arquivo(id) ON DELETE SET NULL,
  CONSTRAINT fk_protocolo_versao_criado_por FOREIGN KEY (criado_por) REFERENCES usuario(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC;

CREATE TABLE protocolo_outra_questao (
  id            CHAR(36)          NOT NULL,
  protocolo_id  CHAR(36)          NOT NULL,
  ordem         SMALLINT UNSIGNED NOT NULL,
  texto         TEXT              NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_outra_questao_ordem (protocolo_id, ordem),
  CONSTRAINT fk_outra_questao_protocolo FOREIGN KEY (protocolo_id) REFERENCES protocolo(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC;

CREATE TABLE objetivo_especifico (
  id            CHAR(36)          NOT NULL,
  protocolo_id  CHAR(36)          NOT NULL,
  ordem         SMALLINT UNSIGNED NOT NULL,
  texto         TEXT              NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_objetivo_ordem (protocolo_id, ordem),
  CONSTRAINT fk_objetivo_protocolo FOREIGN KEY (protocolo_id) REFERENCES protocolo(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC;

CREATE TABLE palavra_chave (
  id            CHAR(36)          NOT NULL,
  protocolo_id  CHAR(36)          NOT NULL,
  ordem         SMALLINT UNSIGNED NOT NULL,
  termo         VARCHAR(150)      NOT NULL,
  idioma_id     SMALLINT UNSIGNED,
  PRIMARY KEY (id),
  UNIQUE KEY uq_palavra_chave (protocolo_id, termo, idioma_id),
  CONSTRAINT fk_palavra_chave_protocolo FOREIGN KEY (protocolo_id) REFERENCES protocolo(id) ON DELETE CASCADE,
  CONSTRAINT fk_palavra_chave_idioma FOREIGN KEY (idioma_id) REFERENCES idioma(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC;

CREATE TABLE descritor (
  id            CHAR(36)          NOT NULL,
  protocolo_id  CHAR(36)          NOT NULL,
  ordem         SMALLINT UNSIGNED NOT NULL,
  termo         VARCHAR(200)      NOT NULL,
  vocabulario   ENUM('DECS','MESH','LIVRE') NOT NULL DEFAULT 'LIVRE',
  codigo        VARCHAR(50)       COMMENT 'ex.: código DeCS/MeSH',
  PRIMARY KEY (id),
  CONSTRAINT fk_descritor_protocolo FOREIGN KEY (protocolo_id) REFERENCES protocolo(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC;

CREATE TABLE string_busca (
  id             CHAR(36)          NOT NULL,
  protocolo_id   CHAR(36)          NOT NULL,
  base_dados_id  CHAR(36)          COMMENT 'nulo = string genérica',
  campo          ENUM('TITULO','RESUMO','PALAVRAS_CHAVE','TODOS') NOT NULL DEFAULT 'TODOS',
  expressao      TEXT              NOT NULL,
  ordem          SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  CONSTRAINT fk_string_busca_protocolo FOREIGN KEY (protocolo_id) REFERENCES protocolo(id) ON DELETE CASCADE,
  CONSTRAINT fk_string_busca_base FOREIGN KEY (base_dados_id) REFERENCES base_dados(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC;

CREATE TABLE questao_analise (
  id            CHAR(36)          NOT NULL,
  protocolo_id  CHAR(36)          NOT NULL,
  codigo        VARCHAR(10)       NOT NULL COMMENT 'QA1, QA2… (RN05)',
  enunciado     TEXT              NOT NULL,
  ordem         SMALLINT UNSIGNED NOT NULL,
  ativo         TINYINT(1)        NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_questao_codigo (protocolo_id, codigo),
  CONSTRAINT fk_questao_protocolo FOREIGN KEY (protocolo_id) REFERENCES protocolo(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC;

CREATE TABLE criterio (
  id            CHAR(36)          NOT NULL,
  protocolo_id  CHAR(36)          NOT NULL,
  tipo          ENUM('INCLUSAO','EXCLUSAO') NOT NULL,
  nome          VARCHAR(100)      NOT NULL COMMENT 'Período, Bases, Idiomas…',
  descricao     TEXT,
  ordem         SMALLINT UNSIGNED NOT NULL,
  PRIMARY KEY (id),
  KEY ix_criterio_protocolo (protocolo_id, tipo, ordem),
  CONSTRAINT fk_criterio_protocolo FOREIGN KEY (protocolo_id) REFERENCES protocolo(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC;

-- -----------------------------------------------------------------------------
-- 1.6 Checklists genéricos e diretrizes de relato
-- -----------------------------------------------------------------------------

CREATE TABLE checklist_modelo (
  id          CHAR(36)     NOT NULL,
  projeto_id  CHAR(36)     COMMENT 'nulo = global',
  nome        VARCHAR(150) NOT NULL,
  descricao   TEXT,
  padrao      TINYINT(1)   NOT NULL DEFAULT 0,
  ativo       TINYINT(1)   NOT NULL DEFAULT 1,
  criado_em   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  CONSTRAINT fk_checklist_modelo_projeto FOREIGN KEY (projeto_id) REFERENCES projeto(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC;

CREATE TABLE checklist_item_modelo (
  id                   CHAR(36)          NOT NULL,
  checklist_modelo_id  CHAR(36)          NOT NULL,
  codigo               VARCHAR(10)       NOT NULL,
  secao                VARCHAR(40)       NOT NULL COMMENT 'Título, Resumo, Introdução, Métodos…',
  ordem                SMALLINT UNSIGNED NOT NULL,
  descricao            TEXT              NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_checklist_item_codigo (checklist_modelo_id, codigo),
  KEY ix_checklist_item_modelo (checklist_modelo_id, ordem),
  CONSTRAINT fk_checklist_item_modelo FOREIGN KEY (checklist_modelo_id) REFERENCES checklist_modelo(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC;

CREATE TABLE diretriz_relato (
  id                   CHAR(36)     NOT NULL,
  nome                 VARCHAR(200) NOT NULL,
  sigla                VARCHAR(30)  NOT NULL,
  versao               VARCHAR(20),
  url_oficial          VARCHAR(300),
  checklist_modelo_id  CHAR(36),
  ativo                TINYINT(1)   NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_diretriz (sigla, versao),
  CONSTRAINT fk_diretriz_checklist FOREIGN KEY (checklist_modelo_id) REFERENCES checklist_modelo(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC
  COMMENT='Diretriz de relato escolhida como referência (RN14). Não armazena texto de checklists de terceiros (RNF16).';

-- -----------------------------------------------------------------------------
-- 1.7 Tipos de revisão e etapas padrão
-- -----------------------------------------------------------------------------

CREATE TABLE tipo_revisao (
  id             CHAR(36)     NOT NULL,
  nome           VARCHAR(120) NOT NULL,
  descricao      TEXT,
  tipo_pai_id    CHAR(36)     COMMENT 'sem ciclos: validado na API e no gatilho opcional',
  sistematica    TINYINT(1)   NOT NULL DEFAULT 0,
  projeto_id     CHAR(36)     COMMENT 'nulo = global',
  criado_por     CHAR(36),
  ativo          TINYINT(1)   NOT NULL DEFAULT 1,
  criado_em      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  atualizado_em  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- nome único no projeto; entre os globais (projeto_id nulo) a API e o gatilho opcional garantem
  UNIQUE KEY uq_tipo_revisao_nome (projeto_id, nome),
  KEY ix_tipo_revisao_pai (tipo_pai_id),
  CONSTRAINT fk_tipo_revisao_pai FOREIGN KEY (tipo_pai_id) REFERENCES tipo_revisao(id) ON DELETE RESTRICT,
  CONSTRAINT fk_tipo_revisao_projeto FOREIGN KEY (projeto_id) REFERENCES projeto(id) ON DELETE CASCADE,
  CONSTRAINT fk_tipo_revisao_criado_por FOREIGN KEY (criado_por) REFERENCES usuario(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC;

CREATE TABLE etapa_modelo (
  id                 CHAR(36)          NOT NULL,
  tipo_revisao_id    CHAR(36)          NOT NULL,
  ordem              SMALLINT UNSIGNED NOT NULL,
  nome               VARCHAR(120)      NOT NULL,
  descricao          TEXT,
  categoria          ENUM('PROTOCOLO','BUSCA','DEDUPLICACAO','TRIAGEM','INCLUSAO',
                          'ANALISE','SINTESE','DISCUSSAO','CHECKLIST','LIVRE') NOT NULL,
  exige_triagem      TINYINT(1) NOT NULL DEFAULT 0,
  permite_exclusao   TINYINT(1) NOT NULL DEFAULT 0,
  motivos_sugeridos  JSON       NOT NULL COMMENT 'array, ex.: ["CRITERIO","DUPLICADO"]',
  PRIMARY KEY (id),
  UNIQUE KEY uq_etapa_modelo_ordem (tipo_revisao_id, ordem),
  UNIQUE KEY uq_etapa_modelo_nome  (tipo_revisao_id, nome),
  CONSTRAINT fk_etapa_modelo_tipo FOREIGN KEY (tipo_revisao_id) REFERENCES tipo_revisao(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC;

-- -----------------------------------------------------------------------------
-- 1.8 Revisões de literatura
-- -----------------------------------------------------------------------------

CREATE TABLE revisao (
  id                   CHAR(36)     NOT NULL,
  projeto_id           CHAR(36)     NOT NULL,
  titulo               VARCHAR(300) NOT NULL,
  tipo_revisao_id      CHAR(36)     NOT NULL,
  diretriz_relato_id   CHAR(36),
  checklist_modelo_id  CHAR(36),
  status               ENUM('PLANEJADA','EM_ANDAMENTO','CONCLUIDA','CANCELADA') NOT NULL DEFAULT 'PLANEJADA',
  dois_revisores       TINYINT(1)   NOT NULL DEFAULT 0,
  etapa_atual_id       CHAR(36)     COMMENT 'FK adicionada na seção 2',
  registro_url         VARCHAR(1000) COMMENT 'onde a revisão foi registrada (PROSPERO, OSF...)',
  registro_identificador VARCHAR(120),
  criado_por           CHAR(36)     NOT NULL,
  criado_em            DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  atualizado_em        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  CONSTRAINT fk_revisao_projeto FOREIGN KEY (projeto_id) REFERENCES projeto(id) ON DELETE CASCADE,
  CONSTRAINT fk_revisao_tipo FOREIGN KEY (tipo_revisao_id) REFERENCES tipo_revisao(id),
  CONSTRAINT fk_revisao_diretriz FOREIGN KEY (diretriz_relato_id) REFERENCES diretriz_relato(id),
  CONSTRAINT fk_revisao_checklist FOREIGN KEY (checklist_modelo_id) REFERENCES checklist_modelo(id),
  CONSTRAINT fk_revisao_criado_por FOREIGN KEY (criado_por) REFERENCES usuario(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC;

CREATE TABLE revisao_etapa (
  id                      CHAR(36)          NOT NULL,
  revisao_id              CHAR(36)          NOT NULL,
  etapa_modelo_id         CHAR(36),
  ordem                   SMALLINT UNSIGNED NOT NULL,
  nome                    VARCHAR(120)      NOT NULL,
  categoria               ENUM('PROTOCOLO','BUSCA','DEDUPLICACAO','TRIAGEM','INCLUSAO',
                               'ANALISE','SINTESE','DISCUSSAO','CHECKLIST','LIVRE') NOT NULL,
  exige_triagem           TINYINT(1) NOT NULL DEFAULT 0,
  permite_exclusao        TINYINT(1) NOT NULL DEFAULT 0,
  status                  ENUM('PENDENTE','EM_ANDAMENTO','CONCLUIDA','DISPENSADA') NOT NULL DEFAULT 'PENDENTE',
  justificativa_dispensa  TEXT       COMMENT 'obrigatória quando DISPENSADA',
  iniciada_em             DATETIME(3),
  concluida_em            DATETIME(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_revisao_etapa_ordem (revisao_id, ordem),
  KEY ix_revisao_etapa_status (revisao_id, status),
  CONSTRAINT fk_revisao_etapa_revisao FOREIGN KEY (revisao_id) REFERENCES revisao(id) ON DELETE CASCADE,
  CONSTRAINT fk_revisao_etapa_modelo FOREIGN KEY (etapa_modelo_id) REFERENCES etapa_modelo(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC;

CREATE TABLE busca (
  id                 CHAR(36)     NOT NULL,
  revisao_id         CHAR(36)     NOT NULL,
  revisao_etapa_id   CHAR(36),
  base_dados_id      CHAR(36)     NOT NULL,
  string_busca_id    CHAR(36),
  expressao_usada    TEXT         NOT NULL,
  campo              ENUM('TITULO','RESUMO','PALAVRAS_CHAVE','TODOS') NOT NULL DEFAULT 'TODOS',
  filtros            TEXT,
  data_busca         DATE         NOT NULL,
  qtd_retornada      INT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'artigos consultados',
  arquivo_id         CHAR(36),
  status_importacao  ENUM('SEM_ARQUIVO','PENDENTE','PROCESSANDO','CONCLUIDA','ERRO') NOT NULL DEFAULT 'SEM_ARQUIVO',
  qtd_importada      INT UNSIGNED NOT NULL DEFAULT 0,
  qtd_duplicados     INT UNSIGNED NOT NULL DEFAULT 0,
  qtd_erros          INT UNSIGNED NOT NULL DEFAULT 0,
  log_importacao     JSON,
  criado_por         CHAR(36)     NOT NULL,
  criado_em          DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_busca_revisao_data (revisao_id, data_busca),
  CONSTRAINT fk_busca_revisao FOREIGN KEY (revisao_id) REFERENCES revisao(id) ON DELETE CASCADE,
  CONSTRAINT fk_busca_etapa FOREIGN KEY (revisao_etapa_id) REFERENCES revisao_etapa(id) ON DELETE SET NULL,
  CONSTRAINT fk_busca_base FOREIGN KEY (base_dados_id) REFERENCES base_dados(id),
  CONSTRAINT fk_busca_string FOREIGN KEY (string_busca_id) REFERENCES string_busca(id) ON DELETE SET NULL,
  CONSTRAINT fk_busca_arquivo FOREIGN KEY (arquivo_id) REFERENCES arquivo(id) ON DELETE SET NULL,
  CONSTRAINT fk_busca_criado_por FOREIGN KEY (criado_por) REFERENCES usuario(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC;

-- -----------------------------------------------------------------------------
-- 1.9 Documentos (artigos, livros, relatórios…)
-- -----------------------------------------------------------------------------

CREATE TABLE documento (
  id                  CHAR(36)          NOT NULL,
  projeto_id          CHAR(36)          NOT NULL,
  titulo              TEXT              NOT NULL,
  titulo_normalizado  VARCHAR(1000)     NOT NULL DEFAULT '' COMMENT 'minúsculas, sem acento e pontuação (RN11)',
  autores             TEXT,
  resumo              TEXT,
  palavras_chave      TEXT,
  ano                 SMALLINT UNSIGNED COMMENT '1500 a 2100',
  periodico           VARCHAR(300),
  fator_impacto       DECIMAL(7,3),
  idioma_id           SMALLINT UNSIGNED,
  tipo_documento_id   SMALLINT UNSIGNED,
  base_dados_id       CHAR(36),
  link                VARCHAR(1000),
  doi                 VARCHAR(255)      COMMENT 'minúsculas, sem https://doi.org/',
  citacoes            INT UNSIGNED,
  ref_nbr             TEXT,
  ref_apa             TEXT,
  ref_apa2            TEXT,
  arquivo_id          CHAR(36),
  dados_originais     JSON              COMMENT 'registro bruto importado (RIS/BibTeX/CSV)',
  criado_por          CHAR(36),
  criado_em           DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  atualizado_em       DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_documento_doi (projeto_id, doi),
  KEY ix_documento_ano_titulo (projeto_id, ano, titulo_normalizado(191)),
  FULLTEXT KEY ft_documento_busca (titulo, resumo, palavras_chave),
  CONSTRAINT fk_documento_projeto FOREIGN KEY (projeto_id) REFERENCES projeto(id) ON DELETE CASCADE,
  CONSTRAINT fk_documento_idioma FOREIGN KEY (idioma_id) REFERENCES idioma(id),
  CONSTRAINT fk_documento_tipo FOREIGN KEY (tipo_documento_id) REFERENCES tipo_documento(id),
  CONSTRAINT fk_documento_base FOREIGN KEY (base_dados_id) REFERENCES base_dados(id),
  CONSTRAINT fk_documento_arquivo FOREIGN KEY (arquivo_id) REFERENCES arquivo(id) ON DELETE SET NULL,
  CONSTRAINT fk_documento_criado_por FOREIGN KEY (criado_por) REFERENCES usuario(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC;

CREATE TABLE referencia (
  id             CHAR(36)     NOT NULL,
  projeto_id     CHAR(36)     NOT NULL,
  documento_id   CHAR(36)     COMMENT 'documento de origem, quando importada',
  abnt           TEXT         COMMENT 'ABNT NBR 6023',
  apa            TEXT         COMMENT 'APA 7ª ed.',
  mla            TEXT         COMMENT 'MLA 9ª ed.',
  chicago        TEXT         COMMENT 'Chicago 17ª ed. (autor-data)',
  vancouver      TEXT         COMMENT 'Vancouver (ICMJE)',
  ieee           TEXT         COMMENT 'IEEE',
  observacao     VARCHAR(500),
  criado_por     CHAR(36),
  criado_em      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  atualizado_em  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_referencia_documento (projeto_id, documento_id),
  CONSTRAINT fk_referencia_projeto FOREIGN KEY (projeto_id) REFERENCES projeto(id) ON DELETE CASCADE,
  CONSTRAINT fk_referencia_documento FOREIGN KEY (documento_id) REFERENCES documento(id) ON DELETE SET NULL,
  CONSTRAINT fk_referencia_criado_por FOREIGN KEY (criado_por) REFERENCES usuario(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC
  COMMENT='Referências do projeto em ABNT NBR 6023, APA, MLA, Chicago, Vancouver e IEEE';

CREATE TABLE tema (
  id          CHAR(36)     NOT NULL,
  projeto_id  CHAR(36)     NOT NULL,
  nome        VARCHAR(120) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_tema (projeto_id, nome),
  CONSTRAINT fk_tema_projeto FOREIGN KEY (projeto_id) REFERENCES projeto(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC;

CREATE TABLE documento_tema (
  documento_id  CHAR(36) NOT NULL,
  tema_id       CHAR(36) NOT NULL,
  PRIMARY KEY (documento_id, tema_id),
  CONSTRAINT fk_documento_tema_documento FOREIGN KEY (documento_id) REFERENCES documento(id) ON DELETE CASCADE,
  CONSTRAINT fk_documento_tema_tema FOREIGN KEY (tema_id) REFERENCES tema(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC;

CREATE TABLE categoria (
  id          CHAR(36)     NOT NULL,
  projeto_id  CHAR(36)     NOT NULL,
  nome        VARCHAR(120) NOT NULL COMMENT 'ex.: Dados Geoespaciais, Web Semântica',
  PRIMARY KEY (id),
  UNIQUE KEY uq_categoria (projeto_id, nome),
  CONSTRAINT fk_categoria_projeto FOREIGN KEY (projeto_id) REFERENCES projeto(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC;

CREATE TABLE revisao_documento (
  id               CHAR(36)    NOT NULL,
  revisao_id       CHAR(36)    NOT NULL,
  documento_id     CHAR(36)    NOT NULL,
  busca_id         CHAR(36),
  origem           ENUM('BUSCA','REVISAO_ANTERIOR','INTEGRADO','MANUAL') NOT NULL DEFAULT 'BUSCA',
  categoria_id     CHAR(36),
  situacao         ENUM('EM_TRIAGEM','INCLUIDO','EXCLUIDO') NOT NULL DEFAULT 'EM_TRIAGEM',
  duplicado_de_id  CHAR(36),
  etapa_atual_id   CHAR(36),
  criado_em        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  atualizado_em    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_revisao_documento (revisao_id, documento_id),
  KEY ix_revisao_documento_situacao (revisao_id, situacao),
  CONSTRAINT fk_rd_revisao FOREIGN KEY (revisao_id) REFERENCES revisao(id) ON DELETE CASCADE,
  CONSTRAINT fk_rd_documento FOREIGN KEY (documento_id) REFERENCES documento(id) ON DELETE CASCADE,
  CONSTRAINT fk_rd_busca FOREIGN KEY (busca_id) REFERENCES busca(id) ON DELETE SET NULL,
  CONSTRAINT fk_rd_categoria FOREIGN KEY (categoria_id) REFERENCES categoria(id) ON DELETE SET NULL,
  CONSTRAINT fk_rd_duplicado_de FOREIGN KEY (duplicado_de_id) REFERENCES revisao_documento(id) ON DELETE SET NULL,
  CONSTRAINT fk_rd_etapa_atual FOREIGN KEY (etapa_atual_id) REFERENCES revisao_etapa(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC;

-- -----------------------------------------------------------------------------
-- 1.10 Triagem
-- RN10: SELECIONADO sem motivo; EXCLUIDO exige motivo; CRITERIO exige
-- criterio_id; OUTRO exige observação (API + gatilho opcional da seção 9).
-- -----------------------------------------------------------------------------

CREATE TABLE triagem_decisao (
  id                    CHAR(36)    NOT NULL,
  revisao_documento_id  CHAR(36)    NOT NULL,
  revisao_etapa_id      CHAR(36)    NOT NULL,
  revisor_id            CHAR(36)    NOT NULL,
  decisao               ENUM('SELECIONADO','EXCLUIDO') NOT NULL,
  motivo                ENUM('CRITERIO','DUPLICADO','SEM_ACESSO','OUTRO'),
  criterio_id           CHAR(36),
  observacao            TEXT,
  decidido_em           DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_triagem_decisao (revisao_documento_id, revisao_etapa_id, revisor_id),
  KEY ix_triagem_decisao_etapa (revisao_etapa_id),
  CONSTRAINT fk_td_rd FOREIGN KEY (revisao_documento_id) REFERENCES revisao_documento(id) ON DELETE CASCADE,
  CONSTRAINT fk_td_etapa FOREIGN KEY (revisao_etapa_id) REFERENCES revisao_etapa(id) ON DELETE CASCADE,
  CONSTRAINT fk_td_revisor FOREIGN KEY (revisor_id) REFERENCES usuario(id),
  CONSTRAINT fk_td_criterio FOREIGN KEY (criterio_id) REFERENCES criterio(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC;

CREATE TABLE triagem_resultado (
  revisao_documento_id  CHAR(36)    NOT NULL,
  revisao_etapa_id      CHAR(36)    NOT NULL,
  decisao_final         ENUM('SELECIONADO','EXCLUIDO') COMMENT 'nula enquanto houver conflito',
  motivo                ENUM('CRITERIO','DUPLICADO','SEM_ACESSO','OUTRO'),
  criterio_id           CHAR(36),
  conflito              TINYINT(1)  NOT NULL DEFAULT 0,
  resolvido_por         CHAR(36),
  resolvido_em          DATETIME(3),
  atualizado_em         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (revisao_documento_id, revisao_etapa_id),
  KEY ix_triagem_resultado_etapa (revisao_etapa_id, decisao_final),
  KEY ix_triagem_conflitos (revisao_etapa_id, conflito),
  CONSTRAINT fk_tr_rd FOREIGN KEY (revisao_documento_id) REFERENCES revisao_documento(id) ON DELETE CASCADE,
  CONSTRAINT fk_tr_etapa FOREIGN KEY (revisao_etapa_id) REFERENCES revisao_etapa(id) ON DELETE CASCADE,
  CONSTRAINT fk_tr_criterio FOREIGN KEY (criterio_id) REFERENCES criterio(id) ON DELETE SET NULL,
  CONSTRAINT fk_tr_resolvido_por FOREIGN KEY (resolvido_por) REFERENCES usuario(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC;

-- -----------------------------------------------------------------------------
-- 1.11 Checklist da revisão
-- -----------------------------------------------------------------------------

CREATE TABLE revisao_checklist_item (
  id                        CHAR(36)          NOT NULL,
  revisao_id                CHAR(36)          NOT NULL,
  checklist_item_modelo_id  CHAR(36),
  codigo                    VARCHAR(10)       NOT NULL,
  secao                     VARCHAR(40)       NOT NULL,
  ordem                     SMALLINT UNSIGNED NOT NULL,
  descricao                 TEXT              NOT NULL COMMENT 'copiada do modelo',
  situacao                  ENUM('ND','REALIZADO','PENDENTE','NAO_REALIZADO') NOT NULL DEFAULT 'ND',
  local_relato              VARCHAR(300),
  atualizado_por            CHAR(36),
  atualizado_em             DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_revisao_checklist (revisao_id, codigo),
  KEY ix_revisao_checklist_ordem (revisao_id, ordem),
  CONSTRAINT fk_rci_revisao FOREIGN KEY (revisao_id) REFERENCES revisao(id) ON DELETE CASCADE,
  CONSTRAINT fk_rci_item_modelo FOREIGN KEY (checklist_item_modelo_id) REFERENCES checklist_item_modelo(id) ON DELETE SET NULL,
  CONSTRAINT fk_rci_atualizado_por FOREIGN KEY (atualizado_por) REFERENCES usuario(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC;

-- -----------------------------------------------------------------------------
-- 1.12 Análise de documentos
-- -----------------------------------------------------------------------------

CREATE TABLE analise (
  id               CHAR(36)     NOT NULL,
  projeto_id       CHAR(36)     NOT NULL,
  nome             VARCHAR(200) NOT NULL,
  descricao        TEXT,
  tipo_revisao_id  CHAR(36)     NOT NULL COMMENT 'RN15',
  revisao_id       CHAR(36),
  fonte            ENUM('INCLUIDOS_REVISAO','INTEGRADOS','REFERENCIAL_TEORICO','SELECAO_MANUAL') NOT NULL DEFAULT 'INCLUIDOS_REVISAO',
  status           ENUM('ABERTA','CONCLUIDA') NOT NULL DEFAULT 'ABERTA',
  criado_por       CHAR(36)     NOT NULL,
  criado_em        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  atualizado_em    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_analise_nome (projeto_id, nome),
  CONSTRAINT fk_analise_projeto FOREIGN KEY (projeto_id) REFERENCES projeto(id) ON DELETE CASCADE,
  CONSTRAINT fk_analise_tipo FOREIGN KEY (tipo_revisao_id) REFERENCES tipo_revisao(id),
  CONSTRAINT fk_analise_revisao FOREIGN KEY (revisao_id) REFERENCES revisao(id) ON DELETE SET NULL,
  CONSTRAINT fk_analise_criado_por FOREIGN KEY (criado_por) REFERENCES usuario(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC;

CREATE TABLE analise_questao (
  analise_id          CHAR(36)          NOT NULL,
  questao_analise_id  CHAR(36)          NOT NULL,
  ordem               SMALLINT UNSIGNED NOT NULL,
  PRIMARY KEY (analise_id, questao_analise_id),
  CONSTRAINT fk_aq_analise FOREIGN KEY (analise_id) REFERENCES analise(id) ON DELETE CASCADE,
  CONSTRAINT fk_aq_questao FOREIGN KEY (questao_analise_id) REFERENCES questao_analise(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC;

CREATE TABLE analise_documento (
  id              CHAR(36)     NOT NULL,
  analise_id      CHAR(36)     NOT NULL,
  documento_id    CHAR(36)     NOT NULL,
  ordem           INT UNSIGNED,
  resumo_assunto  TEXT         COMMENT 'resumo do assunto do documento, base para as respostas',
  consideracoes   TEXT,
  observacoes     TEXT,
  progresso       ENUM('NAO_INICIADO','PARCIAL','CONCLUIDO') NOT NULL DEFAULT 'NAO_INICIADO',
  atualizado_por  CHAR(36),
  atualizado_em   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_analise_documento (analise_id, documento_id),
  CONSTRAINT fk_ad_analise FOREIGN KEY (analise_id) REFERENCES analise(id) ON DELETE CASCADE,
  CONSTRAINT fk_ad_documento FOREIGN KEY (documento_id) REFERENCES documento(id) ON DELETE CASCADE,
  CONSTRAINT fk_ad_atualizado_por FOREIGN KEY (atualizado_por) REFERENCES usuario(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC;

CREATE TABLE resposta (
  id                    CHAR(36)    NOT NULL,
  analise_documento_id  CHAR(36)    NOT NULL,
  questao_analise_id    CHAR(36)    NOT NULL,
  texto                 TEXT,
  atualizado_por        CHAR(36),
  atualizado_em         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_resposta (analise_documento_id, questao_analise_id),
  FULLTEXT KEY ft_resposta_texto (texto),
  CONSTRAINT fk_resposta_ad FOREIGN KEY (analise_documento_id) REFERENCES analise_documento(id) ON DELETE CASCADE,
  CONSTRAINT fk_resposta_questao FOREIGN KEY (questao_analise_id) REFERENCES questao_analise(id) ON DELETE CASCADE,
  CONSTRAINT fk_resposta_atualizado_por FOREIGN KEY (atualizado_por) REFERENCES usuario(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC;

CREATE TABLE matriz_sintese_item (
  id                    CHAR(36)          NOT NULL,
  analise_documento_id  CHAR(36)          NOT NULL,
  ordem                 SMALLINT UNSIGNED NOT NULL,
  citacao               TEXT              COMMENT 'ex.: (AUTOR, 2024, p. 12)',
  texto_original        TEXT,
  texto_parafraseado    TEXT,
  pagina                VARCHAR(20),
  atualizado_em         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_matriz_analise_doc (analise_documento_id, ordem),
  FULLTEXT KEY ft_matriz_textos (citacao, texto_original, texto_parafraseado),
  CONSTRAINT fk_matriz_ad FOREIGN KEY (analise_documento_id) REFERENCES analise_documento(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC;

CREATE TABLE discussao_item (
  id                    CHAR(36)          NOT NULL,
  analise_documento_id  CHAR(36)          NOT NULL,
  ordem                 SMALLINT UNSIGNED NOT NULL,
  ponto_principal       TEXT,
  discussao             TEXT,
  atualizado_em         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_discussao_analise_doc (analise_documento_id, ordem),
  CONSTRAINT fk_discussao_ad FOREIGN KEY (analise_documento_id) REFERENCES analise_documento(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC;

-- -----------------------------------------------------------------------------
-- 1.13 Apoio: comentários, notificações, auditoria, sincronização mobile, fila
-- -----------------------------------------------------------------------------

CREATE TABLE comentario (
  id           CHAR(36)    NOT NULL,
  projeto_id   CHAR(36)    NOT NULL,
  entidade     VARCHAR(50) NOT NULL COMMENT 'protocolo, documento, resposta…',
  entidade_id  CHAR(36)    NOT NULL,
  autor_id     CHAR(36)    NOT NULL,
  pai_id       CHAR(36),
  texto        TEXT        NOT NULL,
  resolvido    TINYINT(1)  NOT NULL DEFAULT 0,
  criado_em    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_comentario_entidade (entidade, entidade_id),
  CONSTRAINT fk_comentario_projeto FOREIGN KEY (projeto_id) REFERENCES projeto(id) ON DELETE CASCADE,
  CONSTRAINT fk_comentario_autor FOREIGN KEY (autor_id) REFERENCES usuario(id),
  CONSTRAINT fk_comentario_pai FOREIGN KEY (pai_id) REFERENCES comentario(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC;

CREATE TABLE notificacao (
  id          CHAR(36)     NOT NULL,
  usuario_id  CHAR(36)     NOT NULL,
  tipo        VARCHAR(50)  NOT NULL COMMENT 'CONVITE, CONFLITO, PROTOCOLO_APROVADO…',
  titulo      VARCHAR(200) NOT NULL,
  dados       JSON         NOT NULL,
  lida_em     DATETIME(3),
  criado_em   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_notificacao_nao_lidas (usuario_id, lida_em, criado_em),
  CONSTRAINT fk_notificacao_usuario FOREIGN KEY (usuario_id) REFERENCES usuario(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC;

CREATE TABLE auditoria (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  projeto_id    CHAR(36),
  usuario_id    CHAR(36),
  entidade      VARCHAR(50) NOT NULL,
  entidade_id   CHAR(36),
  acao          VARCHAR(30) NOT NULL COMMENT 'CRIAR, ALTERAR, EXCLUIR, DECIDIR, CONCLUIR, IMPRIMIR',
  dados_antes   JSON,
  dados_depois  JSON,
  ip            VARCHAR(45) COMMENT 'IPv4 ou IPv6 em texto',
  criado_em     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_auditoria_projeto (projeto_id, criado_em),
  KEY ix_auditoria_entidade (entidade, entidade_id),
  CONSTRAINT fk_auditoria_projeto FOREIGN KEY (projeto_id) REFERENCES projeto(id) ON DELETE SET NULL,
  CONSTRAINT fk_auditoria_usuario FOREIGN KEY (usuario_id) REFERENCES usuario(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC;

CREATE TABLE sync_operacao (
  idempotency_key  VARCHAR(100)      NOT NULL,
  usuario_id       CHAR(36)          NOT NULL,
  rota             VARCHAR(200)      NOT NULL,
  status_http      SMALLINT UNSIGNED NOT NULL,
  resposta         JSON,
  criado_em        DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (idempotency_key),
  KEY ix_sync_operacao_criado (criado_em),
  CONSTRAINT fk_sync_usuario FOREIGN KEY (usuario_id) REFERENCES usuario(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC
  COMMENT='Garante idempotência das gravações vindas do app mobile (seção 9.4 da ERS).';

-- Fila de tarefas em segundo plano. O worker reserva a próxima tarefa com um
-- UPDATE atômico (o MySQL 5.7 não tem SKIP LOCKED):
--   UPDATE fila_tarefa SET status = 'EXECUTANDO', bloqueado_por = :token,
--          bloqueado_ate = NOW(3) + INTERVAL 10 MINUTE, tentativas = tentativas + 1
--    WHERE status = 'PENDENTE' AND executar_apos <= NOW(3)
--    ORDER BY executar_apos LIMIT 1;
--   SELECT * FROM fila_tarefa WHERE bloqueado_por = :token AND status = 'EXECUTANDO';
CREATE TABLE fila_tarefa (
  id              BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT,
  fila            VARCHAR(60)       NOT NULL COMMENT 'importar-busca, gerar-pdf-protocolo, exportar-xlsx…',
  payload         JSON              NOT NULL,
  status          ENUM('PENDENTE','EXECUTANDO','CONCLUIDA','ERRO') NOT NULL DEFAULT 'PENDENTE',
  tentativas      SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  max_tentativas  SMALLINT UNSIGNED NOT NULL DEFAULT 3,
  executar_apos   DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  bloqueado_por   VARCHAR(64)       COMMENT 'token do worker que reservou a tarefa',
  bloqueado_ate   DATETIME(3)       COMMENT 'após esse horário a tarefa volta a PENDENTE',
  ultimo_erro     TEXT,
  criado_em       DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  atualizado_em   DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_fila_tarefa_proxima (status, executar_apos),
  KEY ix_fila_tarefa_bloqueio (bloqueado_por)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC
  COMMENT='Fila de tarefas em segundo plano (importação, PDF, exportação).';


-- =============================================================================
-- 2. CHAVES ESTRANGEIRAS CIRCULARES
-- =============================================================================

ALTER TABLE arquivo
  ADD CONSTRAINT fk_arquivo_projeto FOREIGN KEY (projeto_id) REFERENCES projeto(id) ON DELETE CASCADE;

ALTER TABLE revisao
  ADD CONSTRAINT fk_revisao_etapa_atual FOREIGN KEY (etapa_atual_id)
      REFERENCES revisao_etapa(id) ON DELETE SET NULL;


-- =============================================================================
-- 3. ÍNDICES ADICIONAIS
-- (cada chave estrangeira já tem índice; os compostos estão nas tabelas)
-- =============================================================================

CREATE UNIQUE INDEX uq_usuario_email      ON usuario (email);        -- _unicode_ci: sem distinção de maiúsculas
CREATE UNIQUE INDEX uq_refresh_token_hash ON refresh_token (token_hash);
CREATE INDEX ix_refresh_token_usuario     ON refresh_token (usuario_id, revogado_em);
CREATE INDEX ix_projeto_ativos            ON projeto (status, excluido_em);
CREATE UNIQUE INDEX uq_convite_token      ON convite (token_hash);
CREATE INDEX ix_analise_documento_doc     ON analise_documento (documento_id);


-- =============================================================================
-- 4. VISÕES DO PAINEL DE ETAPAS (aba Etapas — RF32, RN13)
-- =============================================================================

-- Contagens por revisão, etapa de triagem e base (equivalente à aba Etapas)
CREATE OR REPLACE SQL SECURITY INVOKER VIEW vw_painel_etapas AS
SELECT
  r.id                                    AS revisao_id,
  re.id                                   AS revisao_etapa_id,
  re.ordem                                AS etapa_ordem,
  re.nome                                 AS etapa_nome,
  COALESCE(bd.nome, CASE rd.origem
                      WHEN 'REVISAO_ANTERIOR' THEN 'Revisão anterior'
                      WHEN 'INTEGRADO'        THEN 'Integrados'
                      ELSE 'Manual' END)  AS base,
  SUM(CASE WHEN tr.decisao_final = 'SELECIONADO' THEN 1 ELSE 0 END)                           AS selecionados,
  SUM(CASE WHEN tr.decisao_final = 'EXCLUIDO' THEN 1 ELSE 0 END)                              AS excluidos,
  SUM(CASE WHEN tr.decisao_final = 'EXCLUIDO' AND tr.motivo = 'DUPLICADO'  THEN 1 ELSE 0 END) AS excluidos_duplicados,
  SUM(CASE WHEN tr.decisao_final = 'EXCLUIDO' AND tr.motivo = 'SEM_ACESSO' THEN 1 ELSE 0 END) AS excluidos_sem_acesso,
  SUM(CASE WHEN tr.decisao_final = 'EXCLUIDO' AND tr.motivo = 'CRITERIO'   THEN 1 ELSE 0 END) AS excluidos_criterio,
  SUM(CASE WHEN tr.conflito = 1 THEN 1 ELSE 0 END)                                            AS conflitos,
  SUM(CASE WHEN tr.revisao_documento_id IS NOT NULL
            AND tr.decisao_final IS NULL AND tr.conflito = 0 THEN 1 ELSE 0 END)               AS sem_decisao
FROM revisao r
JOIN revisao_etapa re      ON re.revisao_id = r.id AND re.exige_triagem = 1
JOIN revisao_documento rd  ON rd.revisao_id = r.id
LEFT JOIN busca b          ON b.id = rd.busca_id
LEFT JOIN base_dados bd    ON bd.id = b.base_dados_id
LEFT JOIN triagem_resultado tr
       ON tr.revisao_documento_id = rd.id AND tr.revisao_etapa_id = re.id
GROUP BY r.id, re.id, re.ordem, re.nome, bd.nome, rd.origem;

CREATE OR REPLACE SQL SECURITY INVOKER VIEW vw_consultados_por_base AS
SELECT b.revisao_id,
       bd.nome               AS base,
       SUM(b.qtd_retornada)  AS artigos_consultados,
       SUM(b.qtd_importada)  AS importados,
       SUM(b.qtd_duplicados) AS duplicados
FROM busca b
JOIN base_dados bd ON bd.id = b.base_dados_id
GROUP BY b.revisao_id, bd.nome;


-- =============================================================================
-- 5. DADOS INICIAIS
-- =============================================================================

-- 5.1 Bases de dados (listas da planilha)
INSERT INTO base_dados (id, nome, sigla, url) VALUES
  ('00000000-0000-0000-0000-0000000b0001', 'SciELO',                  'SCIELO',   'https://www.scielo.org'),
  ('00000000-0000-0000-0000-0000000b0002', 'IEEE Xplore',             'IEEE',     'https://ieeexplore.ieee.org'),
  ('00000000-0000-0000-0000-0000000b0003', 'Web of Science',          'WOS',      'https://www.webofscience.com'),
  ('00000000-0000-0000-0000-0000000b0004', 'Scopus',                  'SCOPUS',   'https://www.scopus.com'),
  ('00000000-0000-0000-0000-0000000b0005', 'ERIC',                    'ERIC',     'https://eric.ed.gov'),
  ('00000000-0000-0000-0000-0000000b0006', 'EBSCO',                   'EBSCO',    'https://www.ebsco.com'),
  ('00000000-0000-0000-0000-0000000b0007', 'PubMed',                  'PUBMED',   'https://pubmed.ncbi.nlm.nih.gov'),
  ('00000000-0000-0000-0000-0000000b0008', 'ACM Digital Library',     'ACM',      'https://dl.acm.org'),
  ('00000000-0000-0000-0000-0000000b0009', 'Springer',                'SPRINGER', 'https://link.springer.com'),
  ('00000000-0000-0000-0000-0000000b0010', 'Taylor & Francis Online', 'TANDF',    'https://www.tandfonline.com'),
  ('00000000-0000-0000-0000-0000000b0011', 'DeCS/MeSH',               'DECS',     'https://decs.bvsalud.org'),
  ('00000000-0000-0000-0000-0000000b0012', 'Outra',                   'OUTRA',    NULL);

-- 5.2 Idiomas (ids 1–5)
INSERT INTO idioma (codigo, nome) VALUES
  ('pt', 'Português'), ('en', 'Inglês'), ('es', 'Espanhol'), ('fr', 'Francês'), ('de', 'Alemão');

-- 5.3 Tipos de documento (listas da planilha; ids 1–12)
INSERT INTO tipo_documento (nome) VALUES
  ('Artigo'), ('Livro'), ('Capítulo de livro'), ('Resumo'), ('Página Web'),
  ('Documentação online'), ('TCC'), ('Dissertação'), ('Tese'), ('Plataforma'),
  ('Relatório'), ('Artigo de conferência');

-- 5.4 Checklist genérico de relato (texto próprio do sistema — seção 5.1 da ERS)
INSERT INTO checklist_modelo (id, nome, descricao, padrao) VALUES
  ('00000000-0000-0000-0000-000000000c01',
   'Checklist genérico de relato de revisões',
   'Lista de verificação redigida para o sistema, cobrindo os tópicos usuais de relato de revisões de literatura.',
   1);

INSERT INTO checklist_item_modelo (id, checklist_modelo_id, codigo, secao, ordem, descricao) VALUES
  (UUID(),'00000000-0000-0000-0000-000000000c01','CG01','Título',             1,'O título deixa claro o tipo de revisão realizada.'),
  (UUID(),'00000000-0000-0000-0000-000000000c01','CG02','Resumo',             2,'O resumo traz objetivo, método, fontes, número de estudos incluídos e principais achados.'),
  (UUID(),'00000000-0000-0000-0000-000000000c01','CG03','Introdução',         3,'O texto explica por que a revisão é necessária frente ao conhecimento atual.'),
  (UUID(),'00000000-0000-0000-0000-000000000c01','CG04','Introdução',         4,'Objetivos e questões que a revisão responde estão declarados.'),
  (UUID(),'00000000-0000-0000-0000-000000000c01','CG05','Métodos',            5,'Critérios de inclusão e exclusão estão descritos.'),
  (UUID(),'00000000-0000-0000-0000-000000000c01','CG06','Métodos',            6,'Bases, repositórios e outras fontes consultadas estão listadas com a data da última consulta.'),
  (UUID(),'00000000-0000-0000-0000-000000000c01','CG07','Métodos',            7,'As strings de busca completas e os filtros aplicados estão apresentados.'),
  (UUID(),'00000000-0000-0000-0000-000000000c01','CG08','Métodos',            8,'O processo de seleção está descrito (fases, número de revisores, independência, ferramentas).'),
  (UUID(),'00000000-0000-0000-0000-000000000c01','CG09','Métodos',            9,'O modo de extração dos dados dos estudos está descrito.'),
  (UUID(),'00000000-0000-0000-0000-000000000c01','CG10','Métodos',           10,'As variáveis e desfechos extraídos estão definidos.'),
  (UUID(),'00000000-0000-0000-0000-000000000c01','CG11','Métodos',           11,'O método de avaliação de qualidade ou risco de viés está descrito.'),
  (UUID(),'00000000-0000-0000-0000-000000000c01','CG12','Métodos',           12,'O método de síntese (narrativa, temática, estatística) está descrito e justificado.'),
  (UUID(),'00000000-0000-0000-0000-000000000c01','CG13','Métodos',           13,'A forma de avaliar a confiança no conjunto de evidências está descrita.'),
  (UUID(),'00000000-0000-0000-0000-000000000c01','CG14','Resultados',        14,'O número de registros em cada fase da seleção está apresentado, de preferência em fluxograma.'),
  (UUID(),'00000000-0000-0000-0000-000000000c01','CG15','Resultados',        15,'Estudos excluídos na leitura completa estão listados com o motivo.'),
  (UUID(),'00000000-0000-0000-0000-000000000c01','CG16','Resultados',        16,'Cada estudo incluído é citado com suas características principais.'),
  (UUID(),'00000000-0000-0000-0000-000000000c01','CG17','Resultados',        17,'A avaliação de qualidade de cada estudo incluído está apresentada.'),
  (UUID(),'00000000-0000-0000-0000-000000000c01','CG18','Resultados',        18,'Os resultados de cada estudo e da síntese estão apresentados.'),
  (UUID(),'00000000-0000-0000-0000-000000000c01','CG19','Discussão',         19,'Os resultados são interpretados à luz de outras evidências.'),
  (UUID(),'00000000-0000-0000-0000-000000000c01','CG20','Discussão',         20,'Limitações das evidências e do processo de revisão estão discutidas.'),
  (UUID(),'00000000-0000-0000-0000-000000000c01','CG21','Discussão',         21,'Implicações para prática, políticas e pesquisas futuras estão apontadas.'),
  (UUID(),'00000000-0000-0000-0000-000000000c01','CG22','Outras informações',22,'Registro e local de acesso ao protocolo informados, ou declarado que não houve.'),
  (UUID(),'00000000-0000-0000-0000-000000000c01','CG23','Outras informações',23,'Alterações em relação ao protocolo estão explicadas.'),
  (UUID(),'00000000-0000-0000-0000-000000000c01','CG24','Outras informações',24,'Fontes de financiamento, conflitos de interesse e disponibilidade de dados e materiais estão declarados.');

-- 5.5 Diretrizes de relato (somente referência: nome, versão e link oficial)
INSERT INTO diretriz_relato (id, nome, sigla, versao, url_oficial, checklist_modelo_id) VALUES
  ('00000000-0000-0000-0000-0000000d0001', 'Preferred Reporting Items for Systematic Reviews and Meta-Analyses', 'PRISMA', '2020',
   'https://www.prisma-statement.org', '00000000-0000-0000-0000-000000000c01'),
  ('00000000-0000-0000-0000-0000000d0002', 'PRISMA extension for Scoping Reviews', 'PRISMA-ScR', '2018',
   'https://www.prisma-statement.org', '00000000-0000-0000-0000-000000000c01'),
  ('00000000-0000-0000-0000-0000000d0003', 'Sem diretriz específica', 'NENHUMA', NULL, NULL, '00000000-0000-0000-0000-000000000c01');

-- 5.6 Tipos de revisão globais
INSERT INTO tipo_revisao (id, nome, descricao, tipo_pai_id, sistematica) VALUES
  ('00000000-0000-0000-0000-000000000101', 'Narrativa',
   'Revisão não sistemática; cadastro livre do referencial teórico.', NULL, 0),
  ('00000000-0000-0000-0000-000000000102', 'Sistemática',
   'Revisão com protocolo, buscas reprodutíveis e triagem em fases.', NULL, 1);
INSERT INTO tipo_revisao (id, nome, descricao, tipo_pai_id, sistematica) VALUES
  ('00000000-0000-0000-0000-000000000103', 'Integrativa',
   'Subtipo da sistemática que integra estudos de diferentes métodos, revisão anterior e integrados.',
   '00000000-0000-0000-0000-000000000102', 0),
  ('00000000-0000-0000-0000-000000000104', 'De escopo',
   'Subtipo da sistemática para mapear a literatura de um tema.',
   '00000000-0000-0000-0000-000000000102', 0),
  ('00000000-0000-0000-0000-000000000105', 'Rápida',
   'Subtipo da sistemática com etapas simplificadas e um revisor.',
   '00000000-0000-0000-0000-000000000102', 0),
  ('00000000-0000-0000-0000-000000000106', 'Meta-análise',
   'Subtipo da sistemática com síntese estatística das medidas de efeito.',
   '00000000-0000-0000-0000-000000000102', 0);
-- Os subtipos têm sistematica = 0 porque herdam a marca do pai (RN06).

-- 5.7 Etapas padrão
-- Narrativa
INSERT INTO etapa_modelo (id, tipo_revisao_id, ordem, nome, categoria, exige_triagem, permite_exclusao, motivos_sugeridos) VALUES
  (UUID(), '00000000-0000-0000-0000-000000000101', 1, 'Referencial teórico', 'LIVRE',     0, 0, JSON_ARRAY()),
  (UUID(), '00000000-0000-0000-0000-000000000101', 2, 'Análise narrativa',   'ANALISE',   0, 0, JSON_ARRAY()),
  (UUID(), '00000000-0000-0000-0000-000000000101', 3, 'Matriz de síntese',   'SINTESE',   0, 0, JSON_ARRAY()),
  (UUID(), '00000000-0000-0000-0000-000000000101', 4, 'Discussão',           'DISCUSSAO', 0, 0, JSON_ARRAY());

-- Sistemática
INSERT INTO etapa_modelo (id, tipo_revisao_id, ordem, nome, categoria, exige_triagem, permite_exclusao, motivos_sugeridos) VALUES
  (UUID(), '00000000-0000-0000-0000-000000000102',  1, 'Protocolo',                            'PROTOCOLO',    0, 0, JSON_ARRAY()),
  (UUID(), '00000000-0000-0000-0000-000000000102',  2, 'Identificação (buscas)',               'BUSCA',        0, 0, JSON_ARRAY()),
  (UUID(), '00000000-0000-0000-0000-000000000102',  3, 'Remoção de duplicados',                'DEDUPLICACAO', 0, 1, JSON_ARRAY('DUPLICADO')),
  (UUID(), '00000000-0000-0000-0000-000000000102',  4, 'Triagem F1 (título e resumo)',         'TRIAGEM',      1, 1, JSON_ARRAY('CRITERIO','DUPLICADO')),
  (UUID(), '00000000-0000-0000-0000-000000000102',  5, 'Triagem F2 (acesso e leitura parcial)','TRIAGEM',      1, 1, JSON_ARRAY('SEM_ACESSO','CRITERIO')),
  (UUID(), '00000000-0000-0000-0000-000000000102',  6, 'Elegibilidade F3 (texto completo)',    'TRIAGEM',      1, 1, JSON_ARRAY('CRITERIO','OUTRO')),
  (UUID(), '00000000-0000-0000-0000-000000000102',  7, 'Inclusão',                             'INCLUSAO',     0, 0, JSON_ARRAY()),
  (UUID(), '00000000-0000-0000-0000-000000000102',  8, 'Extração e análise',                   'ANALISE',      0, 0, JSON_ARRAY()),
  (UUID(), '00000000-0000-0000-0000-000000000102',  9, 'Síntese',                              'SINTESE',      0, 0, JSON_ARRAY()),
  (UUID(), '00000000-0000-0000-0000-000000000102', 10, 'Discussão',                            'DISCUSSAO',    0, 0, JSON_ARRAY()),
  (UUID(), '00000000-0000-0000-0000-000000000102', 11, 'Checklist de relato',                  'CHECKLIST',    0, 0, JSON_ARRAY());

-- Subtipos: copiam as etapas da Sistemática (RN07) e recebem ajustes
INSERT INTO etapa_modelo (id, tipo_revisao_id, ordem, nome, descricao, categoria, exige_triagem, permite_exclusao, motivos_sugeridos)
SELECT UUID(), t.id, e.ordem, e.nome, e.descricao, e.categoria, e.exige_triagem, e.permite_exclusao, e.motivos_sugeridos
FROM etapa_modelo e
CROSS JOIN (SELECT '00000000-0000-0000-0000-000000000103' AS id
            UNION ALL SELECT '00000000-0000-0000-0000-000000000104'
            UNION ALL SELECT '00000000-0000-0000-0000-000000000105'
            UNION ALL SELECT '00000000-0000-0000-0000-000000000106') AS t
WHERE e.tipo_revisao_id = '00000000-0000-0000-0000-000000000102';

-- O MySQL verifica UNIQUE linha a linha: as renumerações usam ORDER BY para
-- não colidir com a ordem vizinha (RN19).

-- Integrativa: insere "Inclusão de revisão anterior e integrados" entre F3 (6) e Inclusão (7)
UPDATE etapa_modelo SET ordem = ordem + 1
 WHERE tipo_revisao_id = '00000000-0000-0000-0000-000000000103' AND ordem >= 7
 ORDER BY ordem DESC;
INSERT INTO etapa_modelo (id, tipo_revisao_id, ordem, nome, categoria, motivos_sugeridos) VALUES
  (UUID(), '00000000-0000-0000-0000-000000000103', 7, 'Inclusão de revisão anterior e integrados', 'INCLUSAO', JSON_ARRAY());

-- De escopo: síntese por mapeamento
UPDATE etapa_modelo SET nome = 'Síntese por mapeamento', descricao = 'Sem avaliação de qualidade dos estudos.'
 WHERE tipo_revisao_id = '00000000-0000-0000-0000-000000000104' AND ordem = 9;

-- Rápida: F2 e F3 unidas
DELETE FROM etapa_modelo
 WHERE tipo_revisao_id = '00000000-0000-0000-0000-000000000105' AND ordem = 5;
UPDATE etapa_modelo SET nome = 'Triagem F2/F3 (acesso e texto completo)',
                        motivos_sugeridos = JSON_ARRAY('SEM_ACESSO','CRITERIO','OUTRO')
 WHERE tipo_revisao_id = '00000000-0000-0000-0000-000000000105' AND ordem = 6;
UPDATE etapa_modelo SET ordem = ordem - 1
 WHERE tipo_revisao_id = '00000000-0000-0000-0000-000000000105' AND ordem >= 6
 ORDER BY ordem ASC;

-- Meta-análise: extração de medidas de efeito após "Extração e análise" (8)
UPDATE etapa_modelo SET ordem = ordem + 1
 WHERE tipo_revisao_id = '00000000-0000-0000-0000-000000000106' AND ordem >= 9
 ORDER BY ordem DESC;
INSERT INTO etapa_modelo (id, tipo_revisao_id, ordem, nome, categoria, motivos_sugeridos) VALUES
  (UUID(), '00000000-0000-0000-0000-000000000106', 9, 'Extração de medidas de efeito', 'ANALISE', JSON_ARRAY());


-- =============================================================================
-- 6. USUÁRIO ADMINISTRADOR
--    e-mail: admin@konektron.com.br · senha inicial: Admin@2026
--    (hash bcrypt custo 12, compatível com bcrypt/bcryptjs). Troque a senha no
--    primeiro acesso ou gere outro hash:
--    node -e "console.log(require('bcryptjs').hashSync('NovaSenha', 12))"
-- =============================================================================

INSERT INTO usuario (id, nome, email, senha_hash, instituicao, perfil_global, preferencias,
                     ativo, email_verificado_em, consentimento_lgpd_em) VALUES
  ('10000000-0000-0000-0000-000000000000', 'Administrador do Sistema', 'admin@konektron.com.br',
   '$2b$12$z.auTmzSyzddYTmVcULEdeiTncbs31akm4J8t36mvT9ELhH9CTRbW',
   'Konektron', 'ADMIN', JSON_OBJECT('tema', 'claro', 'idiomaReferencias', 'NBR'),
   1, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3));


-- =============================================================================
-- 7. DADOS PARA TESTE  (OPCIONAL — NÃO EXECUTE EM PRODUÇÃO)
--    Todos os usuários de teste usam a senha Teste@2026.
--    Cenário: projeto com protocolo aprovado, revisão integrativa na Triagem F2,
--    9 documentos (1 duplicado, 1 integrado), checklist, análise com respostas,
--    matriz de síntese, discussão, comentários, notificações e auditoria;
--    segundo projeto com protocolo em rascunho.
-- =============================================================================

START TRANSACTION;

-- 7.1 Usuários
INSERT INTO usuario (id, nome, email, senha_hash, instituicao, orcid, perfil_global, preferencias,
                     ativo, email_verificado_em, consentimento_lgpd_em, criado_em) VALUES
  ('10000000-0000-0000-0000-000000000001', 'Ana Souza (responsável)',    'ana.souza@example.com',
   '$2b$12$YEyPPVlfjshny9b7UdGtBe294i8OKExBatRY/NdVhiWN5g4umG662', 'Universidade Exemplo', '0000-0002-1825-0097', 'USUARIO',
   JSON_OBJECT('tema','claro','idiomaReferencias','NBR'), TRUE, '2026-10-01 12:00:00', '2026-10-01 12:00:00', '2026-10-01 12:00:00'),
  ('10000000-0000-0000-0000-000000000002', 'Bruno Lima (colaborador)',   'bruno.lima@example.com',
   '$2b$12$YEyPPVlfjshny9b7UdGtBe294i8OKExBatRY/NdVhiWN5g4umG662', 'Universidade Exemplo', NULL, 'USUARIO',
   JSON_OBJECT('tema','escuro','idiomaReferencias','APA'), TRUE, '2026-10-02 12:00:00', '2026-10-02 12:00:00', '2026-10-02 12:00:00'),
  ('10000000-0000-0000-0000-000000000003', 'Carla Mendes (orientadora)', 'carla.mendes@example.com',
   '$2b$12$YEyPPVlfjshny9b7UdGtBe294i8OKExBatRY/NdVhiWN5g4umG662', 'Universidade Exemplo', NULL, 'USUARIO',
   JSON_OBJECT(), TRUE, '2026-10-02 12:00:00', '2026-10-02 12:00:00', '2026-10-02 12:00:00'),
  ('10000000-0000-0000-0000-000000000004', 'Diego Rocha (leitor)',       'diego.rocha@example.com',
   '$2b$12$YEyPPVlfjshny9b7UdGtBe294i8OKExBatRY/NdVhiWN5g4umG662', NULL, NULL, 'USUARIO',
   JSON_OBJECT(), TRUE, '2026-10-03 12:00:00', '2026-10-03 12:00:00', '2026-10-03 12:00:00'),
  ('10000000-0000-0000-0000-000000000005', 'Elisa Prado (bloqueada)',    'elisa.prado@example.com',
   '$2b$12$YEyPPVlfjshny9b7UdGtBe294i8OKExBatRY/NdVhiWN5g4umG662', NULL, NULL, 'USUARIO',
   JSON_OBJECT(), FALSE, NULL, '2026-10-03 12:00:00', '2026-10-03 12:00:00');

-- 7.2 Projetos, membros e convite pendente
INSERT INTO projeto (id, titulo, area, instituicao, programa, data_inicio, data_fim, status, criado_por, criado_em) VALUES
  ('20000000-0000-0000-0000-000000000001',
   'Ontologias e dados geoespaciais na gestão de recursos hídricos',
   'Ciência da Computação', 'Universidade Exemplo', 'Mestrado em Computação Aplicada',
   '2026-10-01', '2027-09-30', 'ATIVO', '10000000-0000-0000-0000-000000000001', '2026-10-05 13:00:00'),
  ('20000000-0000-0000-0000-000000000002',
   'Referencial teórico sobre métodos ágeis em equipes de pesquisa',
   'Engenharia de Software', 'Universidade Exemplo', NULL,
   '2026-11-01', NULL, 'ATIVO', '10000000-0000-0000-0000-000000000002', '2026-11-02 14:00:00');

INSERT INTO projeto_membro (projeto_id, usuario_id, papel, convidado_em, aceito_em) VALUES
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'RESPONSAVEL', '2026-10-05 13:00:00', '2026-10-05 13:00:00'),
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'COLABORADOR', '2026-10-05 13:10:00', '2026-10-05 15:00:00'),
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000003', 'ORIENTADOR',  '2026-10-05 13:10:00', '2026-10-06 09:00:00'),
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000004', 'LEITOR',      '2026-10-05 13:10:00', '2026-10-07 10:00:00'),
  ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', 'RESPONSAVEL', '2026-11-02 14:00:00', '2026-11-02 14:00:00');

INSERT INTO convite (id, projeto_id, email, papel, token_hash, convidado_por, expira_em) VALUES
  ('80000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'fabio.teste@example.com', 'COLABORADOR',
   SHA2('convite-teste-fabio', 256), '10000000-0000-0000-0000-000000000001', '2026-12-31 23:59:59');

-- 7.3 Protocolo aprovado (projeto 1) e rascunho (projeto 2)
INSERT INTO protocolo (id, projeto_id, status, versao_atual, passo_atual, tema, questao_pesquisa, hipotese,
                       objetivo_geral, justificativa, concluido_em, aprovado_por, aprovado_em, parecer, criado_em) VALUES
  ('30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'APROVADO', 1, 8,
   'Uso de ontologias para integrar dados geoespaciais de recursos hídricos.',
   'Como ontologias têm sido aplicadas para integrar dados geoespaciais na gestão de recursos hídricos?',
   'Ontologias de domínio reduzem o esforço de integração entre bases hidrológicas heterogêneas.',
   'Mapear e analisar estudos que aplicam ontologias à integração de dados geoespaciais de recursos hídricos.',
   'Há bases hidrológicas dispersas e pouco interoperáveis; a revisão orienta o desenho de uma ontologia de referência.',
   '2026-10-12 18:00:00', '10000000-0000-0000-0000-000000000003', '2026-10-14 10:30:00',
   'Protocolo aprovado. Incluir IEEE Xplore nas buscas.', '2026-10-05 13:05:00'),
  ('30000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000002', 'RASCUNHO', 0, 3,
   'Métodos ágeis aplicados à gestão de equipes de pesquisa acadêmica.',
   'Quais práticas ágeis são relatadas em equipes de pesquisa acadêmica?',
   NULL, NULL, NULL, NULL, NULL, NULL, NULL, '2026-11-02 14:05:00');

INSERT INTO protocolo_outra_questao (id, protocolo_id, ordem, texto) VALUES
  (UUID(), '30000000-0000-0000-0000-000000000001', 1, 'Quais ontologias de domínio são reutilizadas?'),
  (UUID(), '30000000-0000-0000-0000-000000000001', 2, 'Quais padrões geoespaciais (OGC, GeoSPARQL) são adotados?');

INSERT INTO objetivo_especifico (id, protocolo_id, ordem, texto) VALUES
  (UUID(), '30000000-0000-0000-0000-000000000001', 1, 'Identificar as ontologias e vocabulários usados nos estudos.'),
  (UUID(), '30000000-0000-0000-0000-000000000001', 2, 'Classificar as abordagens de integração de dados geoespaciais.'),
  (UUID(), '30000000-0000-0000-0000-000000000001', 3, 'Levantar lacunas e desafios relatados.');

INSERT INTO palavra_chave (id, protocolo_id, ordem, termo, idioma_id) VALUES
  (UUID(), '30000000-0000-0000-0000-000000000001', 1, 'ontologia',          1),
  (UUID(), '30000000-0000-0000-0000-000000000001', 2, 'ontology',           2),
  (UUID(), '30000000-0000-0000-0000-000000000001', 3, 'recursos hídricos',  1),
  (UUID(), '30000000-0000-0000-0000-000000000001', 4, 'water resources',    2),
  (UUID(), '30000000-0000-0000-0000-000000000001', 5, 'geospatial data',    2);

INSERT INTO descritor (id, protocolo_id, ordem, termo, vocabulario, codigo) VALUES
  (UUID(), '30000000-0000-0000-0000-000000000001', 1, 'Web Semântica',        'LIVRE', NULL),
  (UUID(), '30000000-0000-0000-0000-000000000001', 2, 'Sistemas de Informação Geográfica', 'LIVRE', NULL);

INSERT INTO string_busca (id, protocolo_id, base_dados_id, campo, expressao, ordem) VALUES
  ('36000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000b0004', 'TODOS',
   '("ontology" OR "ontologies") AND ("water resources" OR "hydrology") AND ("geospatial" OR "GIS")', 1),
  ('36000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000b0002', 'TODOS',
   '("ontology") AND ("water") AND ("geospatial")', 2),
  ('36000000-0000-0000-0000-000000000003', '30000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000b0001', 'TODOS',
   '(ontologia OR ontology) AND ("recursos hídricos" OR "water resources")', 3);

INSERT INTO questao_analise (id, protocolo_id, codigo, enunciado, ordem) VALUES
  ('37000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'QA1', 'Qual ontologia ou vocabulário o estudo usa?', 1),
  ('37000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000001', 'QA2', 'Qual abordagem de integração de dados é proposta?', 2),
  ('37000000-0000-0000-0000-000000000003', '30000000-0000-0000-0000-000000000001', 'QA3', 'Quais limitações o estudo relata?', 3);

INSERT INTO criterio (id, protocolo_id, tipo, nome, descricao, ordem) VALUES
  ('38000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'INCLUSAO', 'Período',     'Publicados entre 2015 e 2026.', 1),
  ('38000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000001', 'INCLUSAO', 'Idiomas',     'Português, inglês ou espanhol.', 2),
  ('38000000-0000-0000-0000-000000000003', '30000000-0000-0000-0000-000000000001', 'INCLUSAO', 'Publicações', 'Artigos de periódico ou conferência revisados por pares.', 3),
  ('38000000-0000-0000-0000-000000000004', '30000000-0000-0000-0000-000000000001', 'EXCLUSAO', 'Temas',       'Não trata de recursos hídricos.', 1),
  ('38000000-0000-0000-0000-000000000005', '30000000-0000-0000-0000-000000000001', 'EXCLUSAO', 'Acesso',      'Texto completo indisponível.', 2),
  ('38000000-0000-0000-0000-000000000006', '30000000-0000-0000-0000-000000000001', 'EXCLUSAO', 'Relevância',  'Não usa ontologia como contribuição principal.', 3);

-- 7.4 Arquivos (PDF do protocolo v1 e arquivo RIS importado)
INSERT INTO arquivo (id, projeto_id, provedor, chave_storage, nome_original, mime_type, tamanho_bytes, hash_sha256, criado_por, criado_em) VALUES
  ('70000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'LOCAL',
   'projetos/20000000-0000-0000-0000-000000000001/protocolos/v1.pdf', 'protocolo_v1.pdf', 'application/pdf', 284512,
   SHA2('protocolo_v1.pdf', 256), '10000000-0000-0000-0000-000000000001', '2026-10-12 18:01:00'),
  ('70000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001', 'LOCAL',
   'projetos/20000000-0000-0000-0000-000000000001/buscas/scopus-2026-10-15.ris', 'scopus-2026-10-15.ris', 'application/x-research-info-systems', 15872,
   SHA2('scopus-2026-10-15.ris', 256), '10000000-0000-0000-0000-000000000002', '2026-10-15 16:00:00');

INSERT INTO protocolo_versao (id, protocolo_id, versao, snapshot, justificativa, pdf_arquivo_id, criado_por, criado_em) VALUES
  ('31000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 1,
   JSON_OBJECT('tema', 'Uso de ontologias para integrar dados geoespaciais de recursos hídricos.',
               'questaoPesquisa', 'Como ontologias têm sido aplicadas para integrar dados geoespaciais na gestão de recursos hídricos?',
               'objetivosEspecificos', JSON_ARRAY('Identificar as ontologias e vocabulários usados nos estudos.',
                                                  'Classificar as abordagens de integração de dados geoespaciais.',
                                                  'Levantar lacunas e desafios relatados.'),
               'palavrasChave', JSON_ARRAY('ontologia','ontology','recursos hídricos','water resources','geospatial data'),
               'questoes', JSON_ARRAY('QA1','QA2','QA3')),
   NULL, '70000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '2026-10-12 18:00:00');

-- 7.5 Temas e categorias
INSERT INTO tema (id, projeto_id, nome) VALUES
  ('52000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'Ontologias'),
  ('52000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001', 'Recursos hídricos'),
  ('52000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000001', 'Interoperabilidade');

INSERT INTO categoria (id, projeto_id, nome) VALUES
  ('53000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'Dados Geoespaciais'),
  ('53000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001', 'Web Semântica');

-- 7.6 Revisão integrativa com etapas copiadas do tipo (RN08)
INSERT INTO revisao (id, projeto_id, titulo, tipo_revisao_id, diretriz_relato_id, checklist_modelo_id,
                     status, dois_revisores, criado_por, criado_em) VALUES
  ('40000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001',
   'Revisão integrativa: ontologias para dados hídricos', '00000000-0000-0000-0000-000000000103',
   '00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-000000000c01',
   'EM_ANDAMENTO', FALSE, '10000000-0000-0000-0000-000000000001', '2026-10-14 11:00:00');

-- ids das etapas: 41000000-…-0000000000NN, NN = ordem
INSERT INTO revisao_etapa (id, revisao_id, etapa_modelo_id, ordem, nome, categoria, exige_triagem, permite_exclusao,
                           status, iniciada_em, concluida_em)
SELECT CONCAT('41000000-0000-0000-0000-', LPAD(em.ordem, 12, '0')),
       '40000000-0000-0000-0000-000000000001', em.id, em.ordem, em.nome, em.categoria,
       em.exige_triagem, em.permite_exclusao,
       CASE WHEN em.ordem <= 4 THEN 'CONCLUIDA' WHEN em.ordem = 5 THEN 'EM_ANDAMENTO' ELSE 'PENDENTE' END,
       CASE WHEN em.ordem <= 5 THEN TIMESTAMP('2026-10-14 11:00:00') + INTERVAL em.ordem DAY END,
       CASE WHEN em.ordem <= 4 THEN TIMESTAMP('2026-10-14 18:00:00') + INTERVAL em.ordem DAY END
FROM etapa_modelo em
WHERE em.tipo_revisao_id = '00000000-0000-0000-0000-000000000103';
-- Etapas resultantes: 1 Protocolo · 2 Identificação · 3 Duplicados · 4 F1 · 5 F2 (em andamento)
-- · 6 F3 · 7 Inclusão de revisão anterior e integrados · 8 Inclusão · 9 Extração
-- · 10 Síntese · 11 Discussão · 12 Checklist

UPDATE revisao SET etapa_atual_id = '41000000-0000-0000-0000-000000000005'
 WHERE id = '40000000-0000-0000-0000-000000000001';

-- 7.7 Buscas (etapa 2 — Identificação)
INSERT INTO busca (id, revisao_id, revisao_etapa_id, base_dados_id, string_busca_id, expressao_usada, campo, filtros,
                   data_busca, qtd_retornada, arquivo_id, status_importacao, qtd_importada, qtd_duplicados, qtd_erros,
                   log_importacao, criado_por, criado_em) VALUES
  ('42000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', '41000000-0000-0000-0000-000000000002',
   '00000000-0000-0000-0000-0000000b0004', '36000000-0000-0000-0000-000000000001',
   '("ontology" OR "ontologies") AND ("water resources" OR "hydrology") AND ("geospatial" OR "GIS")', 'TODOS',
   '2015–2026; Article, Conference Paper', '2026-10-15', 120, '70000000-0000-0000-0000-000000000002',
   'CONCLUIDA', 4, 0, 0, JSON_OBJECT('registros', 4, 'erros', JSON_ARRAY()), '10000000-0000-0000-0000-000000000002', '2026-10-15 16:00:00'),
  ('42000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000001', '41000000-0000-0000-0000-000000000002',
   '00000000-0000-0000-0000-0000000b0002', '36000000-0000-0000-0000-000000000002',
   '("ontology") AND ("water") AND ("geospatial")', 'TODOS',
   '2015–2026', '2026-10-15', 85, NULL,
   'CONCLUIDA', 3, 1, 0, JSON_OBJECT('registros', 3, 'erros', JSON_ARRAY()), '10000000-0000-0000-0000-000000000002', '2026-10-15 16:30:00'),
  ('42000000-0000-0000-0000-000000000003', '40000000-0000-0000-0000-000000000001', '41000000-0000-0000-0000-000000000002',
   '00000000-0000-0000-0000-0000000b0001', '36000000-0000-0000-0000-000000000003',
   '(ontologia OR ontology) AND ("recursos hídricos" OR "water resources")', 'TODOS',
   NULL, '2026-10-16', 40, NULL,
   'CONCLUIDA', 1, 0, 0, JSON_OBJECT('registros', 1, 'erros', JSON_ARRAY()), '10000000-0000-0000-0000-000000000001', '2026-10-16 10:00:00');

-- 7.8 Documentos (títulos, autores e DOIs fictícios; prefixo DOI 10.5555 é reservado para exemplos)
--     titulo_normalizado e DOI já vêm normalizados, como a API grava (RN11).
INSERT INTO documento (id, projeto_id, titulo, titulo_normalizado, autores, resumo, palavras_chave, ano, periodico, fator_impacto,
                       idioma_id, tipo_documento_id, base_dados_id, link, doi, citacoes, ref_nbr, ref_apa,
                       criado_por, criado_em) VALUES
  ('50000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001',
   'Uma ontologia de domínio para integração de dados hidrológicos', 'uma ontologia de dominio para integracao de dados hidrologicos', 'SILVA, A.; COSTA, B.',
   'Propõe uma ontologia de domínio para integrar séries hidrológicas de diferentes órgãos.',
   'ontologia; hidrologia; integração', 2023, 'Revista Exemplo de Computação', 1.250, 1, 1,
   '00000000-0000-0000-0000-0000000b0004', 'https://example.com/artigos/1', '10.5555/exemplo.2023.001', 14,
   'SILVA, A.; COSTA, B. Uma ontologia de domínio para integração de dados hidrológicos. Revista Exemplo de Computação, 2023.',
   'Silva, A., & Costa, B. (2023). Uma ontologia de domínio para integração de dados hidrológicos. Revista Exemplo de Computação.',
   '10000000-0000-0000-0000-000000000002', '2026-10-15 16:05:00'),
  ('50000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001',
   'Semantic integration of geospatial water data with GeoSPARQL', 'semantic integration of geospatial water data with geosparql', 'OLIVEIRA, C.; SMITH, J.',
   'Uses GeoSPARQL and linked data to integrate watershed datasets.',
   'GeoSPARQL; linked data; watershed', 2022, 'Journal of Example Informatics', 2.430, 2, 1,
   '00000000-0000-0000-0000-0000000b0004', 'https://example.com/artigos/2', '10.5555/exemplo.2022.002', 31,
   NULL, NULL, '10000000-0000-0000-0000-000000000002', '2026-10-15 16:05:00'),
  ('50000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000001',
   'Knowledge graphs for flood risk management', 'knowledge graphs for flood risk management', 'NGUYEN, T.; PEREIRA, D.',
   'Builds a knowledge graph combining rainfall, river level and land use data.',
   'knowledge graph; flood; risk', 2024, 'Example Water Journal', 3.100, 2, 1,
   '00000000-0000-0000-0000-0000000b0004', 'https://example.com/artigos/3', '10.5555/exemplo.2024.003', 6,
   NULL, NULL, '10000000-0000-0000-0000-000000000002', '2026-10-15 16:05:00'),
  ('50000000-0000-0000-0000-000000000004', '20000000-0000-0000-0000-000000000001',
   'Ontology-based metadata for hydrological sensor networks', 'ontology based metadata for hydrological sensor networks', 'GARCIA, M.',
   'Describes sensor metadata with an ontology aligned to SOSA/SSN.',
   'SOSA; sensors; metadata', 2019, 'Example Sensors Letters', 0.980, 2, 12,
   '00000000-0000-0000-0000-0000000b0004', 'https://example.com/artigos/4', '10.5555/exemplo.2019.004', 22,
   NULL, NULL, '10000000-0000-0000-0000-000000000002', '2026-10-15 16:05:00'),
  ('50000000-0000-0000-0000-000000000005', '20000000-0000-0000-0000-000000000001',
   'Interoperabilidade de dados de bacias hidrográficas com padrões OGC', 'interoperabilidade de dados de bacias hidrograficas com padroes ogc', 'SANTOS, E.; ALMEIDA, F.',
   'Avalia serviços OGC para compartilhar dados de bacias hidrográficas.',
   'OGC; WFS; bacias hidrográficas', 2021, 'Anais do Simpósio Exemplo', NULL, 1, 12,
   '00000000-0000-0000-0000-0000000b0002', 'https://example.com/artigos/5', '10.5555/exemplo.2021.005', 9,
   NULL, NULL, '10000000-0000-0000-0000-000000000002', '2026-10-15 16:35:00'),
  ('50000000-0000-0000-0000-000000000006', '20000000-0000-0000-0000-000000000001',
   'Deep learning for urban traffic prediction', 'deep learning for urban traffic prediction', 'LEE, K.',
   'Predicts traffic flow with recurrent neural networks.',
   'deep learning; traffic', 2020, 'Example Transport Review', 1.700, 2, 1,
   '00000000-0000-0000-0000-0000000b0002', 'https://example.com/artigos/6', '10.5555/exemplo.2020.006', 40,
   NULL, NULL, '10000000-0000-0000-0000-000000000002', '2026-10-15 16:35:00'),
  ('50000000-0000-0000-0000-000000000007', '20000000-0000-0000-0000-000000000001',
   'Ontologias aplicadas à outorga de uso da água', 'ontologias aplicadas a outorga de uso da agua', 'FERREIRA, G.',
   'Estudo de caso de ontologia para apoiar processos de outorga.',
   'ontologia; outorga; água', 2018, 'Revista Brasileira Exemplo', NULL, 1, 1,
   '00000000-0000-0000-0000-0000000b0001', 'https://example.com/artigos/7', NULL, 3,
   NULL, NULL, '10000000-0000-0000-0000-000000000001', '2026-10-16 10:05:00'),
  -- duplicado do documento 1 (mesmo DOI, vindo de outra base)
  ('50000000-0000-0000-0000-000000000008', '20000000-0000-0000-0000-000000000001',
   'Uma Ontologia de Domínio para Integração de Dados Hidrológicos.', 'uma ontologia de dominio para integracao de dados hidrologicos', 'Silva, A.; Costa, B.',
   NULL, NULL, 2023, 'Revista Exemplo de Computação', NULL, 1, 1,
   '00000000-0000-0000-0000-0000000b0002', NULL, '10.5555/exemplo.2023.001', NULL,
   NULL, NULL, '10000000-0000-0000-0000-000000000002', '2026-10-15 16:35:00'),
  -- integrado (snowballing)
  ('50000000-0000-0000-0000-000000000009', '20000000-0000-0000-0000-000000000001',
   'Linked data para gestão de recursos hídricos: um mapeamento', 'linked data para gestao de recursos hidricos um mapeamento', 'MOURA, H.; TAVARES, I.',
   'Mapeamento de iniciativas de dados ligados no setor hídrico.',
   'linked data; recursos hídricos', 2025, 'Revista Exemplo de Sistemas', 0.750, 1, 1,
   NULL, 'https://example.com/artigos/9', '10.5555/exemplo.2025.009', 2,
   NULL, NULL, '10000000-0000-0000-0000-000000000001', '2026-10-20 09:00:00');

INSERT INTO documento_tema (documento_id, tema_id) VALUES
  ('50000000-0000-0000-0000-000000000001', '52000000-0000-0000-0000-000000000001'),
  ('50000000-0000-0000-0000-000000000001', '52000000-0000-0000-0000-000000000002'),
  ('50000000-0000-0000-0000-000000000002', '52000000-0000-0000-0000-000000000003'),
  ('50000000-0000-0000-0000-000000000003', '52000000-0000-0000-0000-000000000002'),
  ('50000000-0000-0000-0000-000000000009', '52000000-0000-0000-0000-000000000003');

-- 7.9 Documentos na revisão (rd8 é duplicado de rd1; rd9 é integrado)
INSERT INTO revisao_documento (id, revisao_id, documento_id, busca_id, origem, categoria_id, situacao,
                               duplicado_de_id, etapa_atual_id, criado_em) VALUES
  ('51000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001',
   '42000000-0000-0000-0000-000000000001', 'BUSCA', '53000000-0000-0000-0000-000000000002', 'EM_TRIAGEM', NULL,
   '41000000-0000-0000-0000-000000000005', '2026-10-15 16:05:00'),
  ('51000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000002',
   '42000000-0000-0000-0000-000000000001', 'BUSCA', '53000000-0000-0000-0000-000000000001', 'EM_TRIAGEM', NULL,
   '41000000-0000-0000-0000-000000000005', '2026-10-15 16:05:00'),
  ('51000000-0000-0000-0000-000000000003', '40000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000003',
   '42000000-0000-0000-0000-000000000001', 'BUSCA', '53000000-0000-0000-0000-000000000002', 'EM_TRIAGEM', NULL,
   '41000000-0000-0000-0000-000000000005', '2026-10-15 16:05:00'),
  ('51000000-0000-0000-0000-000000000004', '40000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000004',
   '42000000-0000-0000-0000-000000000001', 'BUSCA', NULL, 'EXCLUIDO', NULL,
   '41000000-0000-0000-0000-000000000005', '2026-10-15 16:05:00'),
  ('51000000-0000-0000-0000-000000000005', '40000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000005',
   '42000000-0000-0000-0000-000000000002', 'BUSCA', '53000000-0000-0000-0000-000000000001', 'EM_TRIAGEM', NULL,
   '41000000-0000-0000-0000-000000000005', '2026-10-15 16:35:00'),
  ('51000000-0000-0000-0000-000000000006', '40000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000006',
   '42000000-0000-0000-0000-000000000002', 'BUSCA', NULL, 'EXCLUIDO', NULL,
   '41000000-0000-0000-0000-000000000004', '2026-10-15 16:35:00'),
  ('51000000-0000-0000-0000-000000000007', '40000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000007',
   '42000000-0000-0000-0000-000000000003', 'BUSCA', NULL, 'EXCLUIDO', NULL,
   '41000000-0000-0000-0000-000000000004', '2026-10-16 10:05:00'),
  ('51000000-0000-0000-0000-000000000008', '40000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000008',
   '42000000-0000-0000-0000-000000000002', 'BUSCA', NULL, 'EXCLUIDO', '51000000-0000-0000-0000-000000000001',
   '41000000-0000-0000-0000-000000000003', '2026-10-15 16:35:00'),
  ('51000000-0000-0000-0000-000000000009', '40000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000009',
   NULL, 'INTEGRADO', '53000000-0000-0000-0000-000000000002', 'INCLUIDO', NULL,
   '41000000-0000-0000-0000-000000000007', '2026-10-20 09:00:00');

-- 7.10 Triagem: etapa 3 (duplicados), 4 (F1, concluída) e 5 (F2, em andamento)
INSERT INTO triagem_decisao (id, revisao_documento_id, revisao_etapa_id, revisor_id, decisao, motivo, criterio_id, observacao, decidido_em) VALUES
  (UUID(), '51000000-0000-0000-0000-000000000008', '41000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000002', 'EXCLUIDO', 'DUPLICADO', NULL, 'Mesmo DOI do documento 1 (Scopus).', '2026-10-17 09:00:00'),
  (UUID(), '51000000-0000-0000-0000-000000000001', '41000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001', 'SELECIONADO', NULL, NULL, NULL, '2026-10-18 10:00:00'),
  (UUID(), '51000000-0000-0000-0000-000000000002', '41000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001', 'SELECIONADO', NULL, NULL, NULL, '2026-10-18 10:05:00'),
  (UUID(), '51000000-0000-0000-0000-000000000003', '41000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001', 'SELECIONADO', NULL, NULL, NULL, '2026-10-18 10:10:00'),
  (UUID(), '51000000-0000-0000-0000-000000000004', '41000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001', 'SELECIONADO', NULL, NULL, NULL, '2026-10-18 10:15:00'),
  (UUID(), '51000000-0000-0000-0000-000000000005', '41000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000002', 'SELECIONADO', NULL, NULL, NULL, '2026-10-18 10:20:00'),
  (UUID(), '51000000-0000-0000-0000-000000000006', '41000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000002', 'EXCLUIDO', 'CRITERIO', '38000000-0000-0000-0000-000000000004', NULL, '2026-10-18 10:25:00'),
  (UUID(), '51000000-0000-0000-0000-000000000007', '41000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000002', 'EXCLUIDO', 'OUTRO', NULL, 'Publicado antes de 2015, fora do período.', '2026-10-18 10:30:00'),
  (UUID(), '51000000-0000-0000-0000-000000000001', '41000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000001', 'SELECIONADO', NULL, NULL, NULL, '2026-10-21 14:00:00'),
  (UUID(), '51000000-0000-0000-0000-000000000002', '41000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000001', 'SELECIONADO', NULL, NULL, NULL, '2026-10-21 14:05:00'),
  (UUID(), '51000000-0000-0000-0000-000000000003', '41000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000002', 'SELECIONADO', NULL, NULL, NULL, '2026-10-21 14:10:00'),
  (UUID(), '51000000-0000-0000-0000-000000000004', '41000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000002', 'EXCLUIDO', 'SEM_ACESSO', NULL, NULL, '2026-10-21 14:15:00');
-- rd5 ainda sem decisão na F2

INSERT INTO triagem_resultado (revisao_documento_id, revisao_etapa_id, decisao_final, motivo, criterio_id, conflito) VALUES
  ('51000000-0000-0000-0000-000000000008', '41000000-0000-0000-0000-000000000003', 'EXCLUIDO',    'DUPLICADO',  NULL, FALSE),
  ('51000000-0000-0000-0000-000000000001', '41000000-0000-0000-0000-000000000004', 'SELECIONADO', NULL,         NULL, FALSE),
  ('51000000-0000-0000-0000-000000000002', '41000000-0000-0000-0000-000000000004', 'SELECIONADO', NULL,         NULL, FALSE),
  ('51000000-0000-0000-0000-000000000003', '41000000-0000-0000-0000-000000000004', 'SELECIONADO', NULL,         NULL, FALSE),
  ('51000000-0000-0000-0000-000000000004', '41000000-0000-0000-0000-000000000004', 'SELECIONADO', NULL,         NULL, FALSE),
  ('51000000-0000-0000-0000-000000000005', '41000000-0000-0000-0000-000000000004', 'SELECIONADO', NULL,         NULL, FALSE),
  ('51000000-0000-0000-0000-000000000006', '41000000-0000-0000-0000-000000000004', 'EXCLUIDO',    'CRITERIO',   '38000000-0000-0000-0000-000000000004', FALSE),
  ('51000000-0000-0000-0000-000000000007', '41000000-0000-0000-0000-000000000004', 'EXCLUIDO',    'OUTRO',      NULL, FALSE),
  ('51000000-0000-0000-0000-000000000001', '41000000-0000-0000-0000-000000000005', 'SELECIONADO', NULL,         NULL, FALSE),
  ('51000000-0000-0000-0000-000000000002', '41000000-0000-0000-0000-000000000005', 'SELECIONADO', NULL,         NULL, FALSE),
  ('51000000-0000-0000-0000-000000000003', '41000000-0000-0000-0000-000000000005', 'SELECIONADO', NULL,         NULL, FALSE),
  ('51000000-0000-0000-0000-000000000004', '41000000-0000-0000-0000-000000000005', 'EXCLUIDO',    'SEM_ACESSO', NULL, FALSE),
  ('51000000-0000-0000-0000-000000000005', '41000000-0000-0000-0000-000000000005', NULL,          NULL,         NULL, FALSE);

-- 7.11 Checklist da revisão (copiado do modelo) com algumas situações preenchidas
INSERT INTO revisao_checklist_item (id, revisao_id, checklist_item_modelo_id, codigo, secao, ordem, descricao)
SELECT UUID(), '40000000-0000-0000-0000-000000000001', cim.id, cim.codigo, cim.secao, cim.ordem, cim.descricao
FROM checklist_item_modelo cim
WHERE cim.checklist_modelo_id = '00000000-0000-0000-0000-000000000c01';

UPDATE revisao_checklist_item SET situacao = 'REALIZADO', local_relato = 'Título do artigo', atualizado_por = '10000000-0000-0000-0000-000000000001'
 WHERE revisao_id = '40000000-0000-0000-0000-000000000001' AND codigo = 'CG01';
UPDATE revisao_checklist_item SET situacao = 'REALIZADO', local_relato = 'Seção 2.1', atualizado_por = '10000000-0000-0000-0000-000000000001'
 WHERE revisao_id = '40000000-0000-0000-0000-000000000001' AND codigo IN ('CG05','CG06','CG07');
UPDATE revisao_checklist_item SET situacao = 'PENDENTE', atualizado_por = '10000000-0000-0000-0000-000000000001'
 WHERE revisao_id = '40000000-0000-0000-0000-000000000001' AND codigo IN ('CG08','CG14');
UPDATE revisao_checklist_item SET situacao = 'NAO_REALIZADO', atualizado_por = '10000000-0000-0000-0000-000000000001'
 WHERE revisao_id = '40000000-0000-0000-0000-000000000001' AND codigo = 'CG22';

-- 7.12 Análise com respostas, matriz de síntese e discussão
INSERT INTO analise (id, projeto_id, nome, descricao, tipo_revisao_id, revisao_id, fonte, status, criado_por, criado_em) VALUES
  ('60000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001',
   'Análise integrativa – rodada 1', 'Primeira leitura dos documentos selecionados e do integrado.',
   '00000000-0000-0000-0000-000000000103', '40000000-0000-0000-0000-000000000001',
   'SELECAO_MANUAL', 'ABERTA', '10000000-0000-0000-0000-000000000001', '2026-10-22 09:00:00');

INSERT INTO analise_questao (analise_id, questao_analise_id, ordem) VALUES
  ('60000000-0000-0000-0000-000000000001', '37000000-0000-0000-0000-000000000001', 1),
  ('60000000-0000-0000-0000-000000000001', '37000000-0000-0000-0000-000000000002', 2),
  ('60000000-0000-0000-0000-000000000001', '37000000-0000-0000-0000-000000000003', 3);

INSERT INTO analise_documento (id, analise_id, documento_id, ordem, consideracoes, observacoes, progresso, atualizado_por) VALUES
  ('61000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001', 1,
   'Estudo central para o referencial.', 'Reaproveitar o modelo de classes.', 'CONCLUIDO', '10000000-0000-0000-0000-000000000001'),
  ('61000000-0000-0000-0000-000000000002', '60000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000002', 2,
   NULL, 'Falta responder QA3.', 'PARCIAL', '10000000-0000-0000-0000-000000000002'),
  ('61000000-0000-0000-0000-000000000003', '60000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000009', 3,
   NULL, NULL, 'NAO_INICIADO', NULL);

INSERT INTO resposta (id, analise_documento_id, questao_analise_id, texto, atualizado_por) VALUES
  (UUID(), '61000000-0000-0000-0000-000000000001', '37000000-0000-0000-0000-000000000001', 'Ontologia própria alinhada a SOSA/SSN e GeoSPARQL.', '10000000-0000-0000-0000-000000000001'),
  (UUID(), '61000000-0000-0000-0000-000000000001', '37000000-0000-0000-0000-000000000002', 'Mediação semântica sobre bases relacionais com mapeamentos R2RML.', '10000000-0000-0000-0000-000000000001'),
  (UUID(), '61000000-0000-0000-0000-000000000001', '37000000-0000-0000-0000-000000000003', 'Avaliação feita com uma única bacia hidrográfica.', '10000000-0000-0000-0000-000000000001'),
  (UUID(), '61000000-0000-0000-0000-000000000002', '37000000-0000-0000-0000-000000000001', 'GeoSPARQL e vocabulários de dados ligados.', '10000000-0000-0000-0000-000000000002'),
  (UUID(), '61000000-0000-0000-0000-000000000002', '37000000-0000-0000-0000-000000000002', 'Publicação dos conjuntos como dados ligados com consultas federadas.', '10000000-0000-0000-0000-000000000002');

INSERT INTO matriz_sintese_item (id, analise_documento_id, ordem, citacao, texto_original, texto_parafraseado, pagina) VALUES
  (UUID(), '61000000-0000-0000-0000-000000000001', 1, '(SILVA; COSTA, 2023, p. 4)',
   'A ontologia reduziu o tempo de integração entre as bases avaliadas.',
   'Os autores relatam menor esforço para integrar as bases após adotar a ontologia.', '4'),
  (UUID(), '61000000-0000-0000-0000-000000000001', 2, '(SILVA; COSTA, 2023, p. 9)',
   'A avaliação limitou-se a uma bacia hidrográfica.',
   'O estudo reconhece que a validação ocorreu em um único cenário.', '9'),
  (UUID(), '61000000-0000-0000-0000-000000000002', 1, '(OLIVEIRA; SMITH, 2022, p. 7)',
   'GeoSPARQL enabled spatial queries across datasets.',
   'O uso de GeoSPARQL permitiu consultas espaciais entre os conjuntos de dados.', '7');

INSERT INTO discussao_item (id, analise_documento_id, ordem, ponto_principal, discussao) VALUES
  (UUID(), '61000000-0000-0000-0000-000000000001', 1, 'Reuso de ontologias de sensores',
   'O alinhamento a SOSA/SSN sugere que a ontologia do projeto deve reutilizar esses padrões.'),
  (UUID(), '61000000-0000-0000-0000-000000000002', 1, 'Consultas espaciais',
   'GeoSPARQL aparece como padrão de fato para consultas espaciais em dados ligados.');

-- 7.13 Comentários, notificações, auditoria, sincronização e fila
INSERT INTO comentario (id, projeto_id, entidade, entidade_id, autor_id, pai_id, texto, resolvido, criado_em) VALUES
  ('90000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'protocolo', '30000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000003', NULL, 'Inclua a IEEE Xplore entre as bases.', TRUE, '2026-10-13 09:00:00'),
  ('90000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001', 'protocolo', '30000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000001', '90000000-0000-0000-0000-000000000001', 'Incluída na string 2.', TRUE, '2026-10-13 11:00:00'),
  ('90000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000001', 'documento', '50000000-0000-0000-0000-000000000002',
   '10000000-0000-0000-0000-000000000002', NULL, 'Conferir se o texto completo está disponível no portal da universidade.', FALSE, '2026-10-21 15:00:00');

INSERT INTO notificacao (id, usuario_id, tipo, titulo, dados, lida_em, criado_em) VALUES
  (UUID(), '10000000-0000-0000-0000-000000000001', 'PROTOCOLO_APROVADO', 'Protocolo aprovado pela orientadora',
   JSON_OBJECT('projetoId','20000000-0000-0000-0000-000000000001','versao',1), '2026-10-14 12:00:00', '2026-10-14 10:30:00'),
  (UUID(), '10000000-0000-0000-0000-000000000001', 'COMENTARIO', 'Novo comentário em documento',
   JSON_OBJECT('comentarioId','90000000-0000-0000-0000-000000000003'), NULL, '2026-10-21 15:00:00'),
  (UUID(), '10000000-0000-0000-0000-000000000003', 'CONVITE', 'Você foi convidada para um projeto',
   JSON_OBJECT('projetoId','20000000-0000-0000-0000-000000000001'), '2026-10-06 09:00:00', '2026-10-05 13:10:00');

INSERT INTO auditoria (projeto_id, usuario_id, entidade, entidade_id, acao, dados_antes, dados_depois, ip, criado_em) VALUES
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'protocolo', '30000000-0000-0000-0000-000000000001',
   'CONCLUIR', JSON_OBJECT('status','RASCUNHO'), JSON_OBJECT('status','CONCLUIDO','versao',1), '177.10.20.30', '2026-10-12 18:00:00'),
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000003', 'protocolo', '30000000-0000-0000-0000-000000000001',
   'ALTERAR', JSON_OBJECT('status','CONCLUIDO'), JSON_OBJECT('status','APROVADO'), '2804:14c:1234::1', '2026-10-14 10:30:00'),
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'protocolo', '30000000-0000-0000-0000-000000000001',
   'IMPRIMIR', NULL, JSON_OBJECT('arquivoId','70000000-0000-0000-0000-000000000001'), '177.10.20.30', '2026-10-12 18:01:00'),
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'triagem_decisao', NULL,
   'DECIDIR', NULL, JSON_OBJECT('revisaoDocumentoId','51000000-0000-0000-0000-000000000006','decisao','EXCLUIDO','motivo','CRITERIO'), '177.10.20.31', '2026-10-18 10:25:00');

INSERT INTO sync_operacao (idempotency_key, usuario_id, rota, status_http, resposta, criado_em) VALUES
  ('mob-7f3c2a10-0001', '10000000-0000-0000-0000-000000000002', 'PUT /etapas/41000000-0000-0000-0000-000000000005/documentos/51000000-0000-0000-0000-000000000003/decisao',
   200, JSON_OBJECT('ok', TRUE), '2026-10-21 14:10:00');

INSERT INTO fila_tarefa (fila, payload, status, tentativas, executar_apos, criado_em) VALUES
  ('importar-busca', JSON_OBJECT('buscaId','42000000-0000-0000-0000-000000000001'), 'CONCLUIDA', 1, '2026-10-15 16:00:00', '2026-10-15 16:00:00'),
  ('gerar-pdf-protocolo', JSON_OBJECT('protocoloId','30000000-0000-0000-0000-000000000001','versao',1), 'CONCLUIDA', 1, '2026-10-12 18:00:00', '2026-10-12 18:00:00'),
  ('exportar-xlsx', JSON_OBJECT('projetoId','20000000-0000-0000-0000-000000000001'), 'PENDENTE', 0, '2026-11-05 12:00:00', '2026-11-05 12:00:00');

COMMIT;

-- =============================================================================
-- 8. CONSULTAS DE VERIFICAÇÃO (resultados esperados nos comentários)
-- =============================================================================

-- 45 tabelas e 2 visões
SELECT COUNT(*) AS tabelas FROM information_schema.tables
 WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE';               -- 45

-- Etapas por tipo: De escopo 11, Integrativa 12, Meta-análise 12, Narrativa 4, Rápida 10, Sistemática 11
SELECT t.nome, COUNT(e.id) AS etapas
  FROM tipo_revisao t LEFT JOIN etapa_modelo e ON e.tipo_revisao_id = t.id
 GROUP BY t.id, t.nome ORDER BY t.nome;

-- Painel de etapas da revisão de teste
-- F1: 5 selecionados, 1 excluído por critério (IEEE) e 1 por outro motivo (SciELO)
-- F2: 3 selecionados, 1 sem acesso, 1 sem decisão
SELECT etapa_ordem, etapa_nome, base, selecionados, excluidos, excluidos_criterio,
       excluidos_sem_acesso, excluidos_duplicados, sem_decisao
  FROM vw_painel_etapas
 WHERE revisao_id = '40000000-0000-0000-0000-000000000001'
 ORDER BY etapa_ordem, base;

SELECT * FROM vw_consultados_por_base
 WHERE revisao_id = '40000000-0000-0000-0000-000000000001';                   -- 120 + 85 + 40

-- Candidatos a duplicado (RN11): docs 1 e 8 com mesmo DOI e mesmo título normalizado
SELECT a.id, b.id AS possivel_duplicado, a.doi
  FROM documento a JOIN documento b
    ON b.projeto_id = a.projeto_id AND b.id > a.id AND b.ano = a.ano
   AND (b.doi = a.doi OR b.titulo_normalizado = a.titulo_normalizado);

-- Busca global (RF46) com FULLTEXT
SELECT id, titulo FROM documento
 WHERE MATCH(titulo, resumo, palavras_chave) AGAINST ('ontologia' IN NATURAL LANGUAGE MODE);

-- Administrador
SELECT id, nome, email, perfil_global, ativo FROM usuario WHERE perfil_global = 'ADMIN';


-- =============================================================================
-- 9. ROTINAS E GATILHOS  (OPCIONAL)
--    Reforçam no banco as regras que a API já aplica. Exigem permissão de
--    criar rotinas; em hospedagem compartilhada com log binário ativo o
--    servidor pode responder #1419 — nesse caso ignore esta seção.
--    No phpMyAdmin, o delimitador abaixo é reconhecido na importação.
-- =============================================================================

DROP FUNCTION IF EXISTS fn_normalizar_titulo;
DROP FUNCTION IF EXISTS fn_limpar_doi;
DROP FUNCTION IF EXISTS fn_tipo_e_sistematico;
DROP TRIGGER  IF EXISTS trg_usuario_bi;
DROP TRIGGER  IF EXISTS trg_usuario_bu;
DROP TRIGGER  IF EXISTS trg_projeto_bi;
DROP TRIGGER  IF EXISTS trg_projeto_bu;
DROP TRIGGER  IF EXISTS trg_protocolo_bi;
DROP TRIGGER  IF EXISTS trg_protocolo_bu;
DROP TRIGGER  IF EXISTS trg_protocolo_versao_bi;
DROP TRIGGER  IF EXISTS trg_tipo_revisao_bi;
DROP TRIGGER  IF EXISTS trg_tipo_revisao_bu;
DROP TRIGGER  IF EXISTS trg_revisao_etapa_bi;
DROP TRIGGER  IF EXISTS trg_revisao_etapa_bu;
DROP TRIGGER  IF EXISTS trg_documento_bi;
DROP TRIGGER  IF EXISTS trg_documento_bu;
DROP TRIGGER  IF EXISTS trg_triagem_decisao_bi;
DROP TRIGGER  IF EXISTS trg_triagem_decisao_bu;
DROP TRIGGER  IF EXISTS trg_triagem_resultado_bi;
DROP TRIGGER  IF EXISTS trg_triagem_resultado_bu;

DELIMITER $$

-- Título normalizado (RN11): minúsculas, sem acentos, só a-z/0-9, espaços simples
CREATE FUNCTION fn_normalizar_titulo(t TEXT CHARACTER SET utf8mb4)
RETURNS VARCHAR(1000) CHARACTER SET utf8mb4
DETERMINISTIC NO SQL
BEGIN
  DECLARE s    TEXT CHARACTER SET utf8mb4;
  DECLARE r    TEXT CHARACTER SET utf8mb4 DEFAULT '';
  DECLARE c    VARCHAR(1) CHARACTER SET utf8mb4;
  DECLARE de   VARCHAR(40) CHARACTER SET utf8mb4 DEFAULT 'áàâãäåéèêëíìîïóòôõöúùûüçñýÿ';
  DECLARE para VARCHAR(40) CHARACTER SET utf8mb4 DEFAULT 'aaaaaaeeeeiiiiooooouuuucnyy';
  DECLARE i    INT DEFAULT 1;
  DECLARE n    INT;

  SET s = LOWER(COALESCE(t, ''));
  WHILE i <= CHAR_LENGTH(de) DO
    SET s = REPLACE(s, SUBSTRING(de, i, 1), SUBSTRING(para, i, 1));
    SET i = i + 1;
  END WHILE;

  SET i = 1, n = CHAR_LENGTH(s);
  WHILE i <= n DO
    SET c = SUBSTRING(s, i, 1);
    IF ORD(c) BETWEEN 97 AND 122 OR ORD(c) BETWEEN 48 AND 57 THEN
      SET r = CONCAT(r, c);
    ELSE
      SET r = CONCAT(r, ' ');
    END IF;
    SET i = i + 1;
  END WHILE;

  WHILE LOCATE('  ', r) > 0 DO
    SET r = REPLACE(r, '  ', ' ');
  END WHILE;
  RETURN LEFT(TRIM(r), 1000);
END$$

-- DOI em minúsculas e sem prefixo de URL
CREATE FUNCTION fn_limpar_doi(d VARCHAR(255) CHARACTER SET utf8mb4)
RETURNS VARCHAR(255) CHARACTER SET utf8mb4
DETERMINISTIC NO SQL
BEGIN
  DECLARE s VARCHAR(255) CHARACTER SET utf8mb4;
  IF d IS NULL THEN RETURN NULL; END IF;
  SET s = LOWER(TRIM(d));
  IF    LEFT(s, 19) = 'https://dx.doi.org/' THEN SET s = SUBSTRING(s, 20);
  ELSEIF LEFT(s, 18) = 'http://dx.doi.org/' THEN SET s = SUBSTRING(s, 19);
  ELSEIF LEFT(s, 16) = 'https://doi.org/'   THEN SET s = SUBSTRING(s, 17);
  ELSEIF LEFT(s, 15) = 'http://doi.org/'    THEN SET s = SUBSTRING(s, 16);
  ELSEIF LEFT(s, 4)  = 'doi:'               THEN SET s = SUBSTRING(s, 5);
  END IF;
  RETURN TRIM(s);
END$$

-- Tipo é sistemático se ele ou algum ancestral for (RN06)
CREATE FUNCTION fn_tipo_e_sistematico(p_tipo CHAR(36) CHARACTER SET utf8mb4)
RETURNS TINYINT
READS SQL DATA
BEGIN
  DECLARE v_id  CHAR(36) CHARACTER SET utf8mb4 DEFAULT p_tipo;
  DECLARE v_pai CHAR(36) CHARACTER SET utf8mb4;
  DECLARE v_sis TINYINT;
  DECLARE n     INT DEFAULT 0;
  DECLARE CONTINUE HANDLER FOR NOT FOUND SET v_pai = NULL, v_sis = NULL;

  WHILE v_id IS NOT NULL AND n < 50 DO
    SET v_pai = NULL, v_sis = NULL;
    SELECT tipo_pai_id, sistematica INTO v_pai, v_sis FROM tipo_revisao WHERE id = v_id;
    IF v_sis = 1 THEN RETURN 1; END IF;
    SET v_id = v_pai, n = n + 1;
  END WHILE;
  RETURN 0;
END$$

-- usuario: ORCID no formato 0000-0000-0000-000X
CREATE TRIGGER trg_usuario_bi BEFORE INSERT ON usuario FOR EACH ROW
BEGIN
  IF NEW.orcid IS NOT NULL AND NEW.orcid NOT REGEXP '^[0-9]{4}-[0-9]{4}-[0-9]{4}-[0-9]{3}[0-9X]$' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ORCID inválido.';
  END IF;
END$$
CREATE TRIGGER trg_usuario_bu BEFORE UPDATE ON usuario FOR EACH ROW
BEGIN
  IF NEW.orcid IS NOT NULL AND NEW.orcid NOT REGEXP '^[0-9]{4}-[0-9]{4}-[0-9]{4}-[0-9]{3}[0-9X]$' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ORCID inválido.';
  END IF;
END$$

-- projeto: data_fim >= data_inicio
CREATE TRIGGER trg_projeto_bi BEFORE INSERT ON projeto FOR EACH ROW
BEGIN
  IF NEW.data_fim < NEW.data_inicio THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'data_fim anterior a data_inicio.';
  END IF;
END$$
CREATE TRIGGER trg_projeto_bu BEFORE UPDATE ON projeto FOR EACH ROW
BEGIN
  IF NEW.data_fim < NEW.data_inicio THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'data_fim anterior a data_inicio.';
  END IF;
END$$

-- protocolo: passo de 1 a 11 (folga até 20; o limite exato é validado pela API)
CREATE TRIGGER trg_protocolo_bi BEFORE INSERT ON protocolo FOR EACH ROW
BEGIN
  IF NEW.passo_atual NOT BETWEEN 1 AND 20 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'passo_atual deve ficar entre 1 e 20.';
  END IF;
END$$
CREATE TRIGGER trg_protocolo_bu BEFORE UPDATE ON protocolo FOR EACH ROW
BEGIN
  IF NEW.passo_atual NOT BETWEEN 1 AND 20 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'passo_atual deve ficar entre 1 e 20.';
  END IF;
END$$

-- protocolo_versao: versão >= 1; justificativa a partir da versão 2 (RN04)
CREATE TRIGGER trg_protocolo_versao_bi BEFORE INSERT ON protocolo_versao FOR EACH ROW
BEGIN
  IF NEW.versao < 1 OR (NEW.versao > 1 AND (NEW.justificativa IS NULL OR TRIM(NEW.justificativa) = '')) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Nova versão do protocolo exige justificativa (RN04).';
  END IF;
END$$

-- tipo_revisao: sem autorreferência, sem ciclo e nome global único
CREATE TRIGGER trg_tipo_revisao_bi BEFORE INSERT ON tipo_revisao FOR EACH ROW
BEGIN
  IF NEW.tipo_pai_id IS NOT NULL AND NEW.tipo_pai_id = NEW.id THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Tipo de revisão não pode ser pai de si mesmo.';
  END IF;
  IF NEW.projeto_id IS NULL AND EXISTS (
       SELECT 1 FROM tipo_revisao WHERE projeto_id IS NULL AND nome = NEW.nome) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Já existe tipo de revisão global com esse nome.';
  END IF;
END$$
CREATE TRIGGER trg_tipo_revisao_bu BEFORE UPDATE ON tipo_revisao FOR EACH ROW
BEGIN
  DECLARE v_id CHAR(36) CHARACTER SET utf8mb4;
  DECLARE n    INT DEFAULT 0;
  DECLARE CONTINUE HANDLER FOR NOT FOUND SET v_id = NULL;

  IF NEW.projeto_id IS NULL AND EXISTS (
       SELECT 1 FROM tipo_revisao WHERE projeto_id IS NULL AND nome = NEW.nome AND id <> NEW.id) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Já existe tipo de revisão global com esse nome.';
  END IF;
  -- sobe pela cadeia de pais a partir do novo pai; encontrar o próprio tipo = ciclo
  SET v_id = NEW.tipo_pai_id;
  WHILE v_id IS NOT NULL AND n < 50 DO
    IF v_id = NEW.id THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Hierarquia de tipos de revisão com ciclo.';
    END IF;
    SELECT tipo_pai_id INTO v_id FROM tipo_revisao WHERE id = v_id;
    SET n = n + 1;
  END WHILE;
END$$

-- revisao_etapa: dispensar exige justificativa
CREATE TRIGGER trg_revisao_etapa_bi BEFORE INSERT ON revisao_etapa FOR EACH ROW
BEGIN
  IF NEW.status = 'DISPENSADA' AND (NEW.justificativa_dispensa IS NULL OR TRIM(NEW.justificativa_dispensa) = '') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Etapa dispensada exige justificativa.';
  END IF;
END$$
CREATE TRIGGER trg_revisao_etapa_bu BEFORE UPDATE ON revisao_etapa FOR EACH ROW
BEGIN
  IF NEW.status = 'DISPENSADA' AND (NEW.justificativa_dispensa IS NULL OR TRIM(NEW.justificativa_dispensa) = '') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Etapa dispensada exige justificativa.';
  END IF;
END$$

-- documento: título normalizado, DOI limpo e ano válido (RN11)
CREATE TRIGGER trg_documento_bi BEFORE INSERT ON documento FOR EACH ROW
BEGIN
  IF NEW.ano IS NOT NULL AND NEW.ano NOT BETWEEN 1500 AND 2100 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Ano do documento fora do intervalo 1500–2100.';
  END IF;
  SET NEW.titulo_normalizado = fn_normalizar_titulo(NEW.titulo);
  SET NEW.doi = fn_limpar_doi(NEW.doi);
END$$
CREATE TRIGGER trg_documento_bu BEFORE UPDATE ON documento FOR EACH ROW
BEGIN
  IF NEW.ano IS NOT NULL AND NEW.ano NOT BETWEEN 1500 AND 2100 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Ano do documento fora do intervalo 1500–2100.';
  END IF;
  IF NOT (NEW.titulo <=> OLD.titulo) THEN
    SET NEW.titulo_normalizado = fn_normalizar_titulo(NEW.titulo);
  END IF;
  IF NOT (NEW.doi <=> OLD.doi) THEN
    SET NEW.doi = fn_limpar_doi(NEW.doi);
  END IF;
END$$

-- triagem_decisao: RN10
CREATE TRIGGER trg_triagem_decisao_bi BEFORE INSERT ON triagem_decisao FOR EACH ROW
BEGIN
  IF (NEW.decisao = 'SELECIONADO' AND NEW.motivo IS NOT NULL)
     OR (NEW.decisao = 'EXCLUIDO' AND NEW.motivo IS NULL)
     OR (NEW.motivo = 'CRITERIO' AND NEW.criterio_id IS NULL)
     OR (NEW.motivo = 'OUTRO' AND (NEW.observacao IS NULL OR TRIM(NEW.observacao) = '')) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Decisão de triagem inválida (RN10).';
  END IF;
END$$
CREATE TRIGGER trg_triagem_decisao_bu BEFORE UPDATE ON triagem_decisao FOR EACH ROW
BEGIN
  IF (NEW.decisao = 'SELECIONADO' AND NEW.motivo IS NOT NULL)
     OR (NEW.decisao = 'EXCLUIDO' AND NEW.motivo IS NULL)
     OR (NEW.motivo = 'CRITERIO' AND NEW.criterio_id IS NULL)
     OR (NEW.motivo = 'OUTRO' AND (NEW.observacao IS NULL OR TRIM(NEW.observacao) = '')) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Decisão de triagem inválida (RN10).';
  END IF;
END$$

-- triagem_resultado: com conflito aberto não há decisão final (RN12)
CREATE TRIGGER trg_triagem_resultado_bi BEFORE INSERT ON triagem_resultado FOR EACH ROW
BEGIN
  IF NEW.conflito = 1 AND NEW.decisao_final IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Resultado com conflito não pode ter decisão final (RN12).';
  END IF;
END$$
CREATE TRIGGER trg_triagem_resultado_bu BEFORE UPDATE ON triagem_resultado FOR EACH ROW
BEGIN
  IF NEW.conflito = 1 AND NEW.decisao_final IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Resultado com conflito não pode ter decisão final (RN12).';
  END IF;
END$$

DELIMITER ;

-- Conferência das rotinas (se a seção 9 rodou):
-- SELECT fn_normalizar_titulo('Uma Ontologia de Domínio — Integração!');  -- uma ontologia de dominio integracao
-- SELECT fn_limpar_doi('https://doi.org/10.5555/EXEMPLO.1');              -- 10.5555/exemplo.1
-- SELECT nome, fn_tipo_e_sistematico(id) FROM tipo_revisao;              -- Narrativa 0, demais 1

-- Fim do script
