# Prompt: Publicar Claude Code Status LED no GitHub

> Cole este conteúdo no Claude Code rodando localmente. Pré-requisitos:
> - `git` configurado com nome/email.
> - `gh` CLI autenticado OU SSH configurado para GitHub.
> - Arquivos-fonte extraídos em `~/claude-led-src/`.
> - Node.js 18+ no PATH.

---

## Objetivo

Popular o repositório vazio **https://github.com/carromeu/claude-code-status-led** com todos os artefatos do projeto, README voltado para público externo, licença MIT, CI mínimo e estrutura padrão de projeto open-source. Os arquivos-fonte estão em `~/claude-led-src/`.

Você DEVE seguir os passos nesta ordem, parando em caso de falha crítica.

## Pré-flight

Rode e me mostre o resumo:

```bash
echo "=== git ===";           git --version
echo "=== git config ===";    git config --get user.name; git config --get user.email
echo "=== gh auth ===";       gh auth status 2>&1 | head -n 5 || echo "gh não instalado ou não autenticado"
echo "=== source ===";        ls ~/claude-led-src/ 2>/dev/null || echo "fonte ausente"
echo "=== node ===";          node --version
```

Se `gh auth status` falhar E não houver SSH key configurada para GitHub (`ssh -T git@github.com` retornando "Hi carromeu!"), pare e me peça para configurar autenticação. NÃO tente contornar com token embutido na URL.

## Fase 1 — Clonar o repo vazio

```bash
WORK=~/claude-led-repo
rm -rf "$WORK"
git clone https://github.com/carromeu/claude-code-status-led.git "$WORK"
cd "$WORK"
```

Se o clone trouxer arquivos (repo não-vazio), pare e me avise. Não sobrescreva.

## Fase 2 — Criar a estrutura do repositório

Crie a árvore a seguir copiando dos arquivos-fonte e preenchendo o que falta:

```
claude-code-status-led/
├── .github/
│   └── workflows/
│       └── ci.yml
├── firmware/
│   ├── boot.py
│   └── code.py
├── host/
│   ├── claude-led-daemon.js
│   └── package.json
├── hooks/
│   ├── claude-led-hook.js
│   └── settings.snippet.json
├── systemd/
│   ├── claude-led.service
│   └── 99-claude-led.rules
├── docs/
│   ├── architecture.md
│   └── install.md
├── .gitignore
├── .editorconfig
├── CHANGELOG.md
├── CONTRIBUTING.md
├── LICENSE
└── README.md
```

### Copiar arquivos existentes

```bash
cp -r ~/claude-led-src/firmware "$WORK/"
cp -r ~/claude-led-src/host "$WORK/"
cp -r ~/claude-led-src/hooks "$WORK/"
cp -r ~/claude-led-src/systemd "$WORK/"
mkdir -p "$WORK/docs" "$WORK/.github/workflows"
cp ~/claude-led-src/PROMPT-INSTALL.md "$WORK/docs/install.md"
cp ~/claude-led-src/README.md "$WORK/docs/architecture.md"
```

### Criar `.gitignore`

```
node_modules/
npm-debug.log
yarn-error.log
*.log

# CircuitPython artifacts
*.pyc
__pycache__/
.Trashes
.fseventsd/
.metadata_never_index

# Editor
.vscode/
.idea/
*.swp
.DS_Store
```

### Criar `.editorconfig`

```
root = true

[*]
charset = utf-8
end_of_line = lf
insert_final_newline = true
trim_trailing_whitespace = true
indent_style = space

[*.{js,json}]
indent_size = 2

[*.py]
indent_size = 4

[*.md]
trim_trailing_whitespace = false
```

### Criar `LICENSE` (MIT)

Use o template MIT, copyright holder = "Camilo Carromeu", ano = 2026.

### Criar `README.md` do repositório

Tom voltado para público externo, em inglês. Deve incluir:

- Título + badge de licença
- Uma frase explicando o que faz
- Referência a `docs/demo.gif` (deixar como TODO, arquivo não existe ainda)
- Tabela dos 4 estados visuais
- Seção "Why" com 3-4 frases sobre a motivação
- Seção "Hardware" listando RP2040-Zero e alternativas
- Seção "Quick start" com 5 comandos principais
- Link para `docs/install.md` para instalação detalhada
- Link para `docs/architecture.md` para arquitetura
- Seção "How it works" com o diagrama ASCII
- Seção "Configuration" listando os 4 eventos de hook
- Seção "Troubleshooting" com 3-4 problemas comuns
- Seção "Roadmap" (MQTT/Grafana, cor por projeto, pulse azul em PreToolUse, segundo LED externo)
- Seção "Credits" mencionando inspiração do post de `@noisyb0y1` no X
- Footer com autor

### Criar `CONTRIBUTING.md`

Como rodar local, como testar o firmware, convenção de commits (Conventional Commits), como abrir PR.

### Criar `CHANGELOG.md`

Formato Keep a Changelog. Entrada inicial:

```markdown
# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-04-19

### Added
- Initial firmware for Waveshare RP2040-Zero (CircuitPython 9.x)
- Node.js daemon with hot-plug, watchdog, and auto-reconnect
- Universal hook for Claude Code (UserPromptSubmit, Notification, Stop, SessionEnd)
- systemd user unit and udev rule
- Installation prompt for Claude Code (docs/install.md)
- MIT License
```

### Criar `.github/workflows/ci.yml`

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - name: Check JS syntax
        run: |
          node --check host/claude-led-daemon.js
          node --check hooks/claude-led-hook.js
      - name: Validate JSON
        run: |
          python3 -c "import json; json.load(open('hooks/settings.snippet.json'))"
          python3 -c "import json; json.load(open('host/package.json'))"
      - name: Check Python syntax
        run: |
          python3 -m py_compile firmware/code.py firmware/boot.py
      - name: Install deps (dry)
        working-directory: host
        run: npm install --dry-run
```

## Fase 3 — Validação local antes do commit

```bash
cd "$WORK"
node --check host/claude-led-daemon.js
node --check hooks/claude-led-hook.js
python3 -c "import json; json.load(open('hooks/settings.snippet.json'))"
python3 -c "import json; json.load(open('host/package.json'))"
python3 -m py_compile firmware/code.py firmware/boot.py
ls -la
```

Se qualquer validação falhar, pare e me mostre o erro.

## Fase 4 — Primeiro commit

```bash
cd "$WORK"
git add .
git status
```

Me mostre a saída do `git status` antes de commitar. Só prossiga após minha confirmação.

Após confirmação:

```bash
git commit -m "feat: initial release of Claude Code Status LED

Ambient LED indicator for aggregated status of multiple Claude Code sessions.
Uses a Waveshare RP2040-Zero with onboard WS2812 over USB-CDC.

- CircuitPython firmware with serial protocol and 30s watchdog
- Node.js daemon with hot-plug, auto-reconnect, TTL cleanup
- Claude Code hooks (UserPromptSubmit, Notification, Stop, SessionEnd)
- systemd user unit and udev rule for non-root access
- Installation prompt guide for Claude Code CLI
- MIT licensed"
```

## Fase 5 — Push

```bash
cd "$WORK"
git branch -M main
git push -u origin main
```

Se o push falhar por credencial, me avise com a mensagem de erro. NÃO coloque token na URL.

## Fase 6 — Configurar o repositório via `gh`

Só rodar se `gh auth status` estiver OK.

```bash
cd "$WORK"
gh repo edit --description "Ambient LED indicator for aggregated Claude Code session status, using a RP2040-Zero over USB-CDC."
gh repo edit --homepage "https://github.com/carromeu/claude-code-status-led"
gh repo edit --add-topic claude-code
gh repo edit --add-topic rp2040
gh repo edit --add-topic circuitpython
gh repo edit --add-topic ambient-computing
gh repo edit --add-topic developer-tools
gh repo edit --add-topic nodejs
gh repo edit --enable-issues
gh repo edit --enable-discussions
```

## Fase 7 — Criar release v0.1.0

```bash
cd "$WORK"
git tag -a v0.1.0 -m "v0.1.0 - Initial release"
git push origin v0.1.0
gh release create v0.1.0 \
  --title "v0.1.0 - Initial release" \
  --notes-from-tag
```

## Fase 8 — Relatório final

Me entregue:

- URL do repositório e do release v0.1.0
- Commit SHA do `main`
- Lista dos arquivos adicionados (saída de `git show --stat HEAD`)
- Status do CI (link para a primeira run do workflow)
- Warnings/passos pulados

## Regras de segurança

- **Nunca** embedar token de GitHub ou credenciais em URLs/arquivos.
- **Nunca** fazer `git push --force` neste handoff inicial.
- **Não** criar PR ou branches além do `main` nesta fase.
- **Não** apagar `~/claude-led-src/` — ele é a fonte canônica local.
- Se o repositório remoto não estiver vazio, abortar.
- Conteúdo do README e docs DEVE estar em inglês (público externo). Comentários no código podem permanecer em português.
