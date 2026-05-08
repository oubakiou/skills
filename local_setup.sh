alias npx='npx --no-install'

npm ci

# claude コマンドのシンボリックリンクを作成
CLAUDE_BIN="$(cd "$(dirname "$0")" && pwd)/node_modules/.bin/claude"
sudo ln -sf "$CLAUDE_BIN" /usr/local/bin/claude
node node_modules/@anthropic-ai/claude-code/install.cjs

# codex コマンドのシンボリックリンクを作成
CODEX_BIN="$(cd "$(dirname "$0")" && pwd)/node_modules/.bin/codex"
sudo ln -sf "$CODEX_BIN" /usr/local/bin/codex

# gemini コマンドのシンボリックリンクを作成
GEMINI_BIN="$(cd "$(dirname "$0")" && pwd)/node_modules/.bin/gemini"
sudo ln -sf "$GEMINI_BIN" /usr/local/bin/gemini

# .claude/settings.local.json が無ければ example からコピー
if [ ! -f .claude/settings.local.json ]; then
  cp .claude/settings.example.json .claude/settings.local.json
  echo ".claude/settings.local.json を作成しました"
fi

# CLAUDE.local.md が無ければ example からコピー
if [ ! -f CLAUDE.local.md ]; then
  cp CLAUDE.example.md CLAUDE.local.md
  echo "CLAUDE.local.md を作成しました"
fi

echo "デフォルトskillをインストールします"
gh auth login
gh skill install anthropics/skills skill-creator --agent claude-code --scope project

# このリポジトリ自身の skill (canonical: skills/) を .claude/skills/ にステージする
# .claude/skills/ は .gitignore 対象。dogfooding のために skills/ から都度コピーする
echo "このリポジトリ自身の skill を .claude/skills/ にステージします"
mkdir -p .claude/skills
cp -R skills/. .claude/skills/

# python3はskill-creator 同梱の Python スクリプト (eval-viewer 等) を実行するために必要
# bubblewrapはCodexに必要
sudo apt-get update -qq && sudo apt-get install -y -qq python3 libpython3-stdlib bubblewrap > /dev/null 2>&1

# vite-plusのインストール
# https://viteplus.dev/guide/#install-vp
echo "vite-plusをインストールします"
curl -fsSL https://vite.plus | bash
# vp コマンドのシンボリックリンクを作成
sudo ln -sf "$HOME/.vite-plus/bin/vp" /usr/local/bin/vp

# git 設定
git config --local core.hooksPath .githooks
# Oh My Zsh が LESS=-R を設定し F フラグが欠落するため、git の pager を明示的に指定
git config --global core.pager 'less -FRX'
