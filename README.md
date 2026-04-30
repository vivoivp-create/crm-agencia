# CRM Agência de Marketing
> Node.js + PostgreSQL + WhatsApp API + Claude AI

---

## PASSO A PASSO PARA COLOCAR NO AR

### 1. Criar conta no Railway
- Acesse: https://railway.app
- Clique em "Start a New Project"
- Faça login com GitHub (crie uma conta no GitHub se não tiver)

### 2. Subir o projeto no GitHub
- Crie uma conta em https://github.com se não tiver
- Clique em "New repository" → chame de "crm-agencia"
- Faça upload de todos os arquivos desta pasta

### 3. Conectar ao Railway
- No Railway: "New Project" → "Deploy from GitHub repo"
- Selecione o repositório "crm-agencia"
- O Railway detecta automaticamente que é Node.js

### 4. Adicionar banco de dados PostgreSQL
- No painel do Railway, clique em "+ New" → "Database" → "PostgreSQL"
- O Railway cria o banco e injeta a variável DATABASE_URL automaticamente

### 5. Configurar variáveis de ambiente
No Railway, vá em "Variables" e adicione:

  ANTHROPIC_API_KEY     → sua chave em console.anthropic.com
  WHATSAPP_TOKEN        → token do app na Meta for Developers
  WHATSAPP_PHONE_ID     → ID do número de telefone na Meta
  WHATSAPP_VERIFY_TOKEN → qualquer palavra secreta (ex: minhaagencia123)
  NODE_ENV              → production

### 6. Pegar a URL do seu CRM
- No Railway, clique em "Settings" → "Domains" → "Generate Domain"
- Você vai ter uma URL como: https://crm-agencia.railway.app

### 7. Configurar Webhook do WhatsApp
- Acesse: https://developers.facebook.com
- Vá no seu App → WhatsApp → Configuração
- URL do webhook: https://SUA-URL.railway.app/webhook
- Token de verificação: o mesmo que você colocou em WHATSAPP_VERIFY_TOKEN
- Assine o evento: "messages"

---

## ESTRUTURA DE ARQUIVOS

  crm-agencia/
  ├── server.js          ← Backend (API + Webhook)
  ├── package.json       ← Dependências Node.js
  ├── .env.example       ← Modelo de variáveis de ambiente
  └── public/
      └── index.html     ← Frontend do CRM

---

## FUNCIONALIDADES

- Dashboard com métricas em tempo real
- Gestão de leads com funil de vendas
- Cadastro de clientes
- Histórico de conversas do WhatsApp
- Projetos com progresso e responsável
- Bot automático (Claude responde no WhatsApp)
- Novos contatos criados automaticamente quando mandam mensagem

---

## CUSTO ESTIMADO

  Railway (hospedagem + banco): ~$5/mês após período gratuito
  Anthropic API (Claude):       ~$0,50 a $5/mês (depende do volume)
  WhatsApp API oficial:         gratuito até 1.000 conversas/mês
