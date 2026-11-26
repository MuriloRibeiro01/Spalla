<div align="center">

# 🎻 Spalla

**O braço direito do seu maestro.**
*Dashboard local pra acompanhar builds, logs e agentes de código em tempo real.*

[Português](#-português) · [English](#-english)

![status](https://img.shields.io/badge/status-em%20desenvolvimento-orange)
![license](https://img.shields.io/badge/license-MIT-blue)
![deps](https://img.shields.io/badge/dependencies-zero-brightgreen)

</div>

---

## 🇧🇷 Português

### Por que "Spalla"?

Na orquestra, o **spalla** é o primeiro violino: o braço direito do maestro, quem afina a orquestra e segura o ritmo quando o maestro está olhando pra outro lado.

O Spalla nasceu pra trabalhar ao lado do [Maestri](https://themaestri.app). Os agentes de código rodam builds em segundo plano, e você fica no escuro: sem log, sem progresso, sem saber se travou, se falhou ou se está esperando sua aprovação há vinte minutos. O Spalla acende a luz.

### O que ele faz

> ⚠️ **Em desenvolvimento.** As funcionalidades abaixo compõem a versão 0.1 em construção.

#### 🔨 Build com progresso de verdade
- Wrapper `spalla build` que roda o Gradle com `--console=plain` e grava toda a saída em `.spalla/logs/`.
- Init script do Gradle, compatível com configuration cache, que emite eventos por task. A barra de progresso mostra tasks concluídas/total, não um spinner decorativo.
- Erros (`e:`, `error:`, `FAILURE`, "What went wrong") ficam destacados no log.
- Exit code real, mesmo com `tee` no meio (`pipefail`).

#### 📱 Expo + Android
- Suporte a apps Expo com dev client: roda `expo prebuild` só quando `android/` não existe, e nunca com `--clean` sem confirmação.
- `spalla run`: instala o APK, faz `adb reverse tcp:8081`, sobe o Metro e abre o app.
- `spalla emulator`: status do device e boot do AVD.

#### 🖥️ Dashboard (`localhost:4242`)
Servidor em Node puro, com streaming via SSE e tema escuro. Painéis:

| Painel | O que mostra |
|---|---|
| **Build** | Progresso, task atual, tempo decorrido, status e log ao vivo com busca |
| **Metro** | Log do bundler, com destaque pra erros de JS |
| **Logcat** | Stream filtrado pelo PID do app, colorido por nível, com `FATAL EXCEPTION` em destaque |
| **Emulador** | Device conectado, boot completo, app instalado/rodando |
| **Histórico** | Últimos builds com duração e resultado |
| **Agentes** | Um card por agente, com status, última ação e feed de eventos |
| **Resumo do Maestro** | Último resumo do agente gerenciador em markdown, progresso pelos checkboxes e histórico |

#### 🤖 Agentes e notificações
- Integração via hooks no nível do usuário (ex.: Claude Code). Nada é alterado na config versionada dos projetos.
- Estados: `working`, `tool`, `needs_approval`, `waiting_input`, `done`, `failed`, `idle`.
- Cards em `needs_approval` ou `failed` sobem pro topo e piscam até você olhar.
- Detecção de agente "possivelmente travado" (sem eventos há X minutos).
- Notificação do navegador + som, contador de pendências na aba e silenciar por tipo ou agente.

> 🔒 **O Spalla só avisa, nunca aprova.** Não existe botão pra aprovar comando pelo dashboard. A aprovação acontece no terminal de cada agente, onde você vê o comando completo.

### Princípios

- **Zero dependências:** bash + Node, os dois já estão na sua máquina se você usa Expo.
- **Pessoal e invisível:** a pasta `.spalla/` e o `spalla.config.json` são ignorados via `.git/info/exclude`. O projeto do seu time nem fica sabendo.
- **Agnóstico de projeto:** um arquivo de config por projeto, e o mesmo Spalla em todos.
- **Multiplataforma:** Git Bash no Windows, macOS e Linux.

### Instalação

```bash
git clone https://github.com/<seu-usuario>/spalla.git ~/tools/spalla
echo 'export PATH="$HOME/tools/spalla/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
```

No projeto, crie o `spalla.config.json`:

```json
{
  "name": "meu-app",
  "mobile": "mobile",
  "package": "com.exemplo.meuapp",
  "avd": "Pixel_8_API_35",
  "port": 4242,
  "stuckAfterMinutes": 10
}
```

E ignore localmente:

```bash
printf '.spalla/\nspalla.config.json\n' >> .git/info/exclude
```

### Uso

```bash
spalla dash          # sobe o dashboard em localhost:4242
spalla emulator      # verifica ou sobe o emulador
spalla build         # build com progresso e log
spalla run           # instala, sobe o Metro e abre o app
spalla logcat        # logcat filtrado pelo app
spalla agent-event <agente> <tipo> [mensagem]   # usado pelos hooks
spalla report <agente> [arquivo.md]   # salva um resumo em .md para o Spalla
```

### Roadmap

#### Fase 2: Spalla no bolso 📲
Acompanhar tudo pelo celular, com o PC ligado em casa.
- [ ] Acesso remoto privado via **Tailscale** (`tailscale serve`, com HTTPS e sem expor nada na internet)
- [ ] **PWA** instalável no iPhone (manifest + service worker)
- [ ] Push no iOS (Web Push) ou via **ntfy**
- [ ] Painel de screenshot do emulador (`adb exec-out screencap`)
- [ ] Layout mobile-first e token de acesso opcional

#### Depois disso 🔭
- [ ] Suporte a mais harnesses (Codex, Gemini, OpenCode) conforme os mecanismos de hook de cada um
- [ ] Builds iOS (`xcodebuild`) e web
- [ ] Métricas de build: tempo médio, tasks mais lentas, taxa de cache hit
- [ ] Múltiplos projetos no mesmo dashboard
- [ ] Notificações nativas do SO (toast no Windows, `osascript` no macOS)

### Aviso

Projeto pessoal e independente. Não é afiliado ao Maestri, à Anthropic, ao Expo nem ao Google.

### Licença

[MIT](LICENSE) © 2026 Murilo Ribeiro da Silveira

---

## 🇺🇸 English

### Why "Spalla"?

In an orchestra, the **spalla** (concertmaster) is the first violin: the conductor's right hand, who tunes the orchestra and keeps the tempo while the maestro looks elsewhere.

Spalla was born to work alongside [Maestri](https://themaestri.app). Coding agents run builds in the background, and you're left in the dark: no logs, no progress, no idea whether it's stuck, failed, or has been waiting for your approval for twenty minutes. Spalla turns the lights on.

### What it does

> ⚠️ **Work in progress.** The features below make up version 0.1, currently under construction.

#### 🔨 Builds with real progress
- `spalla build` wrapper that runs Gradle with `--console=plain` and writes all output to `.spalla/logs/`.
- Configuration-cache-compatible Gradle init script that emits per-task events. The progress bar shows completed/total tasks, not a decorative spinner.
- Errors (`e:`, `error:`, `FAILURE`, "What went wrong") are highlighted in the log.
- Real exit codes, even with `tee` in the pipe (`pipefail`).

#### 📱 Expo + Android
- Supports Expo apps with a dev client: runs `expo prebuild` only when `android/` is missing, and never with `--clean` without confirmation.
- `spalla run`: installs the APK, runs `adb reverse tcp:8081`, starts Metro and launches the app.
- `spalla emulator`: device status and AVD boot.

#### 🖥️ Dashboard (`localhost:4242`)
Plain Node server, SSE streaming, dark theme. Panels:

| Panel | Shows |
|---|---|
| **Build** | Progress, current task, elapsed time, status and searchable live log |
| **Metro** | Bundler log, with JS errors highlighted |
| **Logcat** | Stream filtered by app PID, colored by level, `FATAL EXCEPTION` highlighted |
| **Emulator** | Connected device, boot complete, app installed/running |
| **History** | Recent builds with duration and result |
| **Agents** | One card per agent, with status, last action and event feed |
| **Maestro summary** | Latest summary from the managing agent in markdown, progress from checkboxes, and history |

#### 🤖 Agents and notifications
- Integrates through user-level hooks (e.g. Claude Code). Nothing changes in your projects' versioned config.
- States: `working`, `tool`, `needs_approval`, `waiting_input`, `done`, `failed`, `idle`.
- `needs_approval` and `failed` cards jump to the top and blink until you look.
- "Possibly stuck" detection (no events for X minutes).
- Browser notifications + sound, pending counter in the tab title, and mute by type or agent.

> 🔒 **Spalla notifies, it never approves.** There is no button to approve commands from the dashboard. Approvals happen in each agent's terminal, where you can see the full command.

### Principles

- **Zero dependencies:** bash + Node, both already on your machine if you use Expo.
- **Personal and invisible:** `.spalla/` and `spalla.config.json` are ignored via `.git/info/exclude`. Your team's repo never knows.
- **Project-agnostic:** one config file per project, and the same Spalla everywhere.
- **Cross-platform:** Git Bash on Windows, macOS and Linux.

### Installation

```bash
git clone https://github.com/<your-username>/spalla.git ~/tools/spalla
echo 'export PATH="$HOME/tools/spalla/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
```

In your project, create `spalla.config.json`:

```json
{
  "name": "my-app",
  "mobile": "mobile",
  "package": "com.example.myapp",
  "avd": "Pixel_8_API_35",
  "port": 4242,
  "stuckAfterMinutes": 10
}
```

And ignore it locally:

```bash
printf '.spalla/\nspalla.config.json\n' >> .git/info/exclude
```

### Usage

```bash
spalla dash          # start the dashboard at localhost:4242
spalla emulator      # check or boot the emulator
spalla build         # build with progress and logs
spalla run           # install, start Metro and launch the app
spalla logcat        # logcat filtered by app
spalla agent-event <agent> <type> [message]   # used by hooks
spalla report <agent> [file.md]   # save a summary as .md for Spalla
```

### Roadmap

#### Phase 2: Spalla in your pocket 📲
Follow everything from your phone while your PC stays on at home.
- [ ] Private remote access via **Tailscale** (`tailscale serve`, with HTTPS and nothing exposed to the internet)
- [ ] **PWA** installable on iPhone (manifest + service worker)
- [ ] iOS push (Web Push) or via **ntfy**
- [ ] Emulator screenshot panel (`adb exec-out screencap`)
- [ ] Mobile-first layout and optional access token

#### Beyond that 🔭
- [ ] More harnesses (Codex, Gemini, OpenCode), depending on each one's hook mechanism
- [ ] iOS (`xcodebuild`) and web builds
- [ ] Build metrics: average time, slowest tasks, cache hit rate
- [ ] Multiple projects in one dashboard
- [ ] Native OS notifications (Windows toast, macOS `osascript`)

### Disclaimer

Personal, independent project. Not affiliated with Maestri, Anthropic, Expo or Google.

### License

[MIT](LICENSE) © 2026 Murilo Ribeiro da Silveira