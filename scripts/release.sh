#!/usr/bin/env bash
# Cria release + publica no GitHub.
# Uso: pnpm release VERSION=0.2.0 (ou: VERSION=0.2.0 bash scripts/release.sh)
#
# O fluxo está documentado em CONTRIBUTING.md. Em uma linha: gera o
# CHANGELOG com git-cliff, cria commit chore(release) com [skip ci], cria
# tag anotada apontando para o commit ANTERIOR ao chore(release), e
# pergunta se pode pushar.

set -euo pipefail

RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
NC='\033[0m'

die() {
  echo -e "${RED}Erro:${NC} $1" >&2
  exit 1
}

info() {
  echo -e "${GREEN}•${NC} $1"
}

# --- Pré-checks -------------------------------------------------------

command -v git-cliff >/dev/null 2>&1 || die "git-cliff não encontrado. Instale: brew install git-cliff"

# pnpm run passa variáveis via env (pnpm release VERSION=x.y.z → $VERSION)
[ -n "${VERSION:-}" ] || die "informe a versão. Uso: pnpm release VERSION=0.2.0"

# Validação simples de semver pré-1.0 (X.Y.Z com X/Y/Z numéricos).
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  die "versão inválida: '$VERSION'. Use formato X.Y.Z (ex: 0.2.0)"
fi

[ -z "$(git status --porcelain)" ] || die "working tree com mudanças não commitadas. Faça commit antes."

info "Criando release v${VERSION}..."

# --- Gera CHANGELOG ---------------------------------------------------

git-cliff --tag "v${VERSION}" --output CHANGELOG.md

# --- Commit + tag -----------------------------------------------------

# Captura o sha atual ANTES do commit de release. A tag vai apontar pra
# cá para que o `[skip ci]` no commit chore(release) não pule o workflow
# de release disparado pelo tag push.
TAG_COMMIT=$(git rev-parse HEAD)

git add CHANGELOG.md
git commit -m "chore(release): v${VERSION} [skip ci]"
git tag -a "v${VERSION}" -m "v${VERSION}" "$TAG_COMMIT"

echo
info "Commit e tag criados localmente."
echo -e "${YELLOW}Tag v${VERSION} aponta para ${TAG_COMMIT:0:7} (commit anterior ao chore(release)).${NC}"
echo -e "${YELLOW}Isso evita que o [skip ci] do commit de release bloqueie o workflow release.yml.${NC}"
echo

# --- Push opcional ----------------------------------------------------

read -p "Push para origin/main + tag v${VERSION} agora? [y/N] " ans
case "$ans" in
  y|Y)
    git push origin main --follow-tags
    echo
    info "v${VERSION} publicada. GitHub Actions vai criar a Release em ~30s."
    echo -e "  Acompanhe: ${GREEN}gh run watch${NC}  ou na aba Actions do repo."
    ;;
  *)
    echo -e "${YELLOW}Cancelado.${NC} Para publicar depois:"
    echo "  git push origin main --follow-tags"
    ;;
esac
