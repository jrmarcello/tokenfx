/**
 * Integration tests for the i18n-microcopy-consolidation spec — manager
 * surface pt-BR → EN migration (TASK-2).
 *
 * Strategy: static file-content assertions via `fs.readFileSync`. This is
 * the right tool for a microcopy migration:
 *
 *   - The 55 substitutions are literal string changes, not behavioral.
 *     Rendering Server Components through Postgres + auth + DB seed just
 *     to assert "h1 says 'Invites'" is heavy machinery for a trivial signal.
 *   - File-content assertions catch the regression the spec is preventing:
 *     a pt-BR string slipping back into the file at any point.
 *   - No Postgres, no auth, no React renderer — fast and isolated.
 *
 * Coverage map (Test Plan in `.specs/i18n-microcopy-consolidation.md`):
 *
 *   TC-I-01..12 — file-by-file EN string presence checks.
 *   TC-I-18     — diacritic-free sanity grep across manager surface globs.
 *   TC-I-19     — sentinel: check-in-card.tsx + dropoff-card.tsx still
 *                 contain the REQ-11 spec-locked EN marker + no diacritics.
 *   TC-I-20     — tone-word lint workflow still passes for the two locked
 *                 cards (re-runs the exact grep from the workflow).
 *
 * No Postgres dependency — these tests are pure FS reads. They run under
 * the same vitest config as the rest of the integration suite but ignore
 * the shared Postgres setup.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Anchor every path to apps/server so the test is independent of test-runner cwd.
const SERVER_ROOT = path.resolve(__dirname, '..', '..');
const REPO_ROOT = path.resolve(SERVER_ROOT, '..', '..');

const read = (relPathFromServerRoot: string): string =>
  readFileSync(path.join(SERVER_ROOT, relPathFromServerRoot), 'utf8');

describe('i18n-microcopy manager surface (TASK-2)', () => {
  describe('TC-I-01: app/manager/invites/page.tsx', () => {
    const src = read('app/manager/invites/page.tsx');

    it('breadcrumb + h1 render "Invites" in EN', () => {
      // JSX may wrap "Invites" with surrounding whitespace inside the tag —
      // match `>\s*Invites\s*<` so Prettier reformatting can't break the test.
      const invitesMatches = src.match(/>\s*Invites\s*</g) ?? [];
      expect(invitesMatches.length).toBeGreaterThanOrEqual(2);
    });

    it('description paragraph is EN', () => {
      // Collapse JSX whitespace before substring search — JSX may wrap long
      // copy across multiple lines, but the rendered text is normalized.
      const collapsed = src.replace(/\s+/g, ' ');
      expect(collapsed).toContain(
        'Onboarding invites issued to this org. The full token is never shown here',
      );
      expect(collapsed).toContain('only the 8-character prefix.');
    });

    it('does not contain pt-BR markers', () => {
      expect(src).not.toMatch(/Convites/);
      expect(src).not.toMatch(/Criar convite/);
      expect(src).not.toMatch(/Nenhum convite/);
      expect(src).not.toMatch(/Prefixo/);
      expect(src).not.toMatch(/Usos\b/);
      expect(src).not.toMatch(/Expira\b/);
      expect(src).not.toMatch(/Criado por/);
      expect(src).not.toMatch(/Ações/);
    });
  });

  describe('TC-I-02: app/manager/invites/page.tsx empty state', () => {
    it('renders EN empty state', () => {
      const src = read('app/manager/invites/page.tsx');
      expect(src).toContain(
        'No invites yet — create one to onboard a teammate.',
      );
    });
  });

  describe('TC-I-03: app/manager/invites/page.tsx table headers', () => {
    const src = read('app/manager/invites/page.tsx');

    it.each([
      ['Prefix'],
      ['Status'],
      ['Team'],
      ['Uses'],
      ['Expires'],
      ['Created by'],
      ['Actions'],
    ])('table contains EN header %s', (header) => {
      expect(src).toContain(header);
    });

    it('CTA button reads "Create invite"', () => {
      expect(src).toContain('Create invite');
    });
  });

  describe('TC-I-04: app/manager/invites/create/page.tsx', () => {
    const src = read('app/manager/invites/create/page.tsx');

    it('h1 is "Create invite"', () => {
      expect(src).toMatch(/>\s*Create invite\s*</);
    });

    it('breadcrumb includes "Invites" and "Create"', () => {
      const collapsed = src.replace(/\s+/g, ' ');
      expect(collapsed).toMatch(/>\s*Invites\s*</);
      expect(collapsed).toMatch(/>\s*Create\s*</);
    });

    it('description paragraph is EN', () => {
      const collapsed = src.replace(/\s+/g, ' ');
      expect(collapsed).toContain(
        'The full URL is shown only once on the next screen.',
      );
      // Apostrophe in source is `&apos;` (JSX-escaped).
      expect(collapsed).toContain('Copy and send it via your team');
    });

    it('does not contain pt-BR markers', () => {
      expect(src).not.toMatch(/Convites/);
      expect(src).not.toMatch(/Criar Convite/);
      expect(src).not.toMatch(/uma única vez/);
    });
  });

  describe('TC-I-05: app/manager/invites/created/page.tsx', () => {
    const src = read('app/manager/invites/created/page.tsx');

    it('breadcrumb "Invites > Created" + h1 "Invite created"', () => {
      const collapsed = src.replace(/\s+/g, ' ');
      expect(collapsed).toMatch(/>\s*Invites\s*</);
      expect(collapsed).toMatch(/>\s*Created\s*</);
      expect(collapsed).toMatch(/>\s*Invite created\s*</);
    });

    it('one-time warning is EN', () => {
      const collapsed = src.replace(/\s+/g, ' ');
      expect(collapsed).toContain('This URL is shown only once. Copy now.');
    });

    it('next-steps list is EN', () => {
      const collapsed = src.replace(/\s+/g, ' ');
      expect(collapsed).toContain('Next steps:');
      // Apostrophe is `&apos;` in JSX source.
      expect(collapsed).toContain(
        'Send this URL via your team&apos;s secure channel',
      );
      expect(collapsed).toContain('Do NOT use public channels.');
      expect(collapsed).toContain('Reloading this page discards the URL.');
      expect(collapsed).toContain(
        'the old one stays valid until it expires or is revoked.',
      );
    });

    it('back link is EN', () => {
      const collapsed = src.replace(/\s+/g, ' ');
      expect(collapsed).toContain('Back to invites list');
    });

    it('empty state is EN', () => {
      const collapsed = src.replace(/\s+/g, ' ');
      expect(collapsed).toContain('URL not available.');
      expect(collapsed).toContain(
        'The onboarding URL is shown only once right after creation.',
      );
      expect(collapsed).toContain('and create a new invite.');
    });

    it('does not contain pt-BR markers', () => {
      expect(src).not.toMatch(/Convites/);
      expect(src).not.toMatch(/Convite criado/);
      expect(src).not.toMatch(/Próximos passos/);
      expect(src).not.toMatch(/Recarregue/);
      expect(src).not.toMatch(/Voltar para/);
      expect(src).not.toMatch(/URL não disponível/);
    });
  });

  describe('TC-I-06: app/manager/outcomes/page.tsx empty state', () => {
    it('renders EN empty state', () => {
      const src = read('app/manager/outcomes/page.tsx');
      // We assert against the user-visible JSX block ONLY; the doc comment
      // at the top still describes the old phrase by design (comments out of
      // TASK-2 scope per constraint #6).
      const jsxOnly = src.slice(src.indexOf('export default'));
      expect(jsxOnly).toContain(
        'No outcome data yet — devs need to be active',
      );
      expect(jsxOnly).not.toMatch(/Outcome data ainda/);
    });
  });

  describe('TC-I-07: app/manager/layout.tsx nav', () => {
    const src = read('app/manager/layout.tsx');

    it('nav link reads "Invites"', () => {
      expect(src).toMatch(/data-testid="nav-invites"[\s\S]{0,200}>\s*Invites\s*</);
    });

    it('nav region has zero pt-BR diacritics', () => {
      // The "<nav>...</nav>" region is the user-visible chrome. Diacritics
      // anywhere in it would mean a pt-BR leak.
      const navStart = src.indexOf('<nav');
      const navEnd = src.indexOf('</nav>');
      expect(navStart).toBeGreaterThan(0);
      expect(navEnd).toBeGreaterThan(navStart);
      const navRegion = src.slice(navStart, navEnd);
      expect(navRegion).not.toMatch(/[áàâãéêíóôõúüç]/i);
    });
  });

  describe('TC-I-08: components/manager/invite-create-form.tsx labels', () => {
    const src = read('components/manager/invite-create-form.tsx');

    it('field labels are EN', () => {
      expect(src).toContain('Team');
      expect(src).toContain('Max uses');
      expect(src).toContain('Expires in (hours)');
      // Email pattern stays EN ("Email pattern") — was already EN.
      expect(src).toContain('Email pattern');
    });

    it('select placeholder option is EN', () => {
      expect(src).toContain('(no team — org-wide invite)');
    });

    it('email pattern placeholder + helper are EN', () => {
      expect(src).toContain('*@company.com — empty for any');
      expect(src).toContain('Restricts redemption. Empty = any email.');
    });

    it('helper texts under fields are EN', () => {
      expect(src).toContain(
        'Links the user to a team when redeemed. Optional.',
      );
      expect(src).toContain('1–168 (7 days). Default 8h.');
    });

    it('error labels are EN', () => {
      expect(src).toContain('Session expired. Reload the page.');
      expect(src).toContain('Invalid form data. Check the fields.');
      expect(src).toContain('Error creating invite.');
    });

    it('does not contain pt-BR markers', () => {
      expect(src).not.toMatch(/Sessão expirou/);
      expect(src).not.toMatch(/Dados do formulário/);
      expect(src).not.toMatch(/Erro ao criar convite/);
      expect(src).not.toMatch(/Usos máximos/);
      expect(src).not.toMatch(/Expira em/);
      expect(src).not.toMatch(/Vincula o usuário/);
      expect(src).not.toMatch(/Restringe a redenção/);
      expect(src).not.toMatch(/sem time/);
      expect(src).not.toMatch(/vazio para qualquer/);
    });
  });

  describe('TC-I-09: components/manager/invite-create-form.tsx button states', () => {
    it('renders Creating… / Create', () => {
      const src = read('components/manager/invite-create-form.tsx');
      expect(src).toMatch(/isPending\s*\?\s*'Creating…'\s*:\s*'Create'/);
      expect(src).not.toMatch(/Criando…/);
      expect(src).not.toMatch(/'Criar'/);
    });
  });

  describe('TC-I-10: components/manager/invite-revoke-button.tsx dialog', () => {
    const src = read('components/manager/invite-revoke-button.tsx');

    it('button + dialog labels are EN', () => {
      expect(src).toContain('Revoke');
      expect(src).toContain('Revoke invite?');
      expect(src).toContain('This action is irreversible. The prefix');
      expect(src).toContain('will stop accepting redemptions immediately.');
      expect(src).toContain('Cancel');
    });

    it('button states are EN', () => {
      expect(src).toMatch(/isPending\s*\?\s*'Revoking…'\s*:\s*'Revoke'/);
    });

    it('error labels are EN', () => {
      expect(src).toContain('Invite not found.');
      expect(src).toContain('Prefix collision. Reload the page and try again.');
      expect(src).toContain('Invalid prefix.');
      expect(src).toContain('Could not revoke.');
    });

    it('does not contain pt-BR markers', () => {
      expect(src).not.toMatch(/Convite não encontrado/);
      expect(src).not.toMatch(/Conflito de prefixo/);
      expect(src).not.toMatch(/Prefixo inválido/);
      expect(src).not.toMatch(/Não foi possível revogar/);
      expect(src).not.toMatch(/Revogar convite\?/);
      expect(src).not.toMatch(/Esta ação é irreversível/);
      expect(src).not.toMatch(/deixará de aceitar/);
      expect(src).not.toMatch(/Cancelar/);
      expect(src).not.toMatch(/Revogando…/);
      // The literal Portuguese error code comment may stay, but the actual
      // user-visible string "Revogar" should be gone.
      expect(src).not.toMatch(/'Revogar'/);
      expect(src).not.toMatch(/>Revogar</);
    });
  });

  describe('TC-I-11: components/manager/invite-row.tsx status labels', () => {
    const src = read('components/manager/invite-row.tsx');

    it('STATUS_LABEL map is fully EN', () => {
      expect(src).toMatch(/active:\s*'Active'/);
      expect(src).toMatch(/expired:\s*'Expired'/);
      expect(src).toMatch(/exhausted:\s*'Exhausted'/);
      expect(src).toMatch(/revoked:\s*'Revoked'/);
    });

    it('email-pattern fallback is "any"', () => {
      expect(src).toContain('>any</span>');
    });

    it('does not contain pt-BR status markers', () => {
      expect(src).not.toMatch(/'Ativo'/);
      expect(src).not.toMatch(/'Expirado'/);
      expect(src).not.toMatch(/'Esgotado'/);
      expect(src).not.toMatch(/'Revogado'/);
      expect(src).not.toMatch(/>qualquer</);
    });
  });

  describe('TC-I-12: components/manager/flash-copy-button.tsx', () => {
    it('button toggles Copied / Copy in EN', () => {
      const src = read('components/manager/flash-copy-button.tsx');
      expect(src).toMatch(/copied\s*\?\s*'Copied'\s*:\s*'Copy'/);
      expect(src).not.toMatch(/'Copiado'/);
      expect(src).not.toMatch(/'Copiar'/);
    });
  });

  describe('TC-I-18: manager surface diacritic sanity', () => {
    /**
     * Walk app/manager/** and components/manager/** and assert no `.tsx`
     * file contains a JSX-region pt-BR diacritic. We strip block + line
     * comments first because comments are out of TASK-2 scope.
     *
     * Allowlisted files (REQ-5 + REQ-11 verbatim): the check-in/dropoff cards
     * are EN-only by design — they're verified in TC-I-19 (positive sentinel)
     * and TC-I-20 (workflow grep). They contain no diacritics either way.
     */
    const stripComments = (src: string): string => {
      // Strip block comments /* ... */ (including JSDoc), then line comments.
      // This is good-enough for ASCII source — JSX strings never contain
      // unescaped `/*` so we don't have to worry about strings that look
      // like comment delimiters.
      let stripped = src.replace(/\/\*[\s\S]*?\*\//g, '');
      stripped = stripped.replace(/(^|[^:])\/\/[^\n]*/g, '$1');
      return stripped;
    };

    const collectTsx = (absDir: string): string[] => {
      const out: string[] = [];
      const stack = [absDir];
      while (stack.length > 0) {
        const dir = stack.pop()!;
        for (const entry of readdirSync(dir)) {
          const full = path.join(dir, entry);
          const s = statSync(full);
          if (s.isDirectory()) {
            stack.push(full);
          } else if (entry.endsWith('.tsx')) {
            out.push(full);
          }
        }
      }
      return out;
    };

    it('app/manager/**.tsx + components/manager/**.tsx have no JSX pt-BR diacritics', () => {
      const files = [
        ...collectTsx(path.join(SERVER_ROOT, 'app', 'manager')),
        ...collectTsx(path.join(SERVER_ROOT, 'components', 'manager')),
      ];
      expect(files.length).toBeGreaterThan(0);

      const offenders: string[] = [];
      for (const f of files) {
        const src = readFileSync(f, 'utf8');
        const noComments = stripComments(src);
        const m = noComments.match(/[áàâãéêíóôõúüç]/i);
        if (m) {
          offenders.push(`${path.relative(SERVER_ROOT, f)}: matched ${m[0]}`);
        }
      }
      expect(offenders).toEqual([]);
    });
  });

  describe('TC-I-19: REQ-11 sentinel — check-in-card.tsx + dropoff-card.tsx untouched', () => {
    it('check-in-card.tsx still contains the REQ-11 spec-locked marker', () => {
      const src = read('components/manager/check-in-card.tsx');
      // The REQ-11 verbatim phrase "It's not a flag." is locked into the card.
      // We assert on the substring "not a flag" which is the part the
      // tone-lint workflow uses as the allowlist anchor.
      expect(src).toMatch(/not a flag/);
    });

    it('check-in-card.tsx has no pt-BR diacritics', () => {
      const src = read('components/manager/check-in-card.tsx');
      expect(src).not.toMatch(/[áàâãéêíóôõúüç]/i);
    });

    it('dropoff-card.tsx has no pt-BR diacritics', () => {
      const src = read('components/manager/dropoff-card.tsx');
      expect(src).not.toMatch(/[áàâãéêíóôõúüç]/i);
    });
  });

  describe('TC-I-20: tone-word lint workflow grep still passes', () => {
    /**
     * Re-runs the exact grep command from .github/workflows/lint-tone.yml
     * (dropoff-card.tsx strict-zero + check-in-card.tsx allowlist) against
     * the current source. exit 0 means the workflow would still pass.
     */
    it('dropoff-card.tsx: forbidden tone words absent', () => {
      const cmd = `grep -nE 'alert|warning|flag|violation|breach' ${path.join(
        SERVER_ROOT,
        'components',
        'manager',
        'dropoff-card.tsx',
      )}`;
      const result = spawnSync('sh', ['-c', cmd], { encoding: 'utf8' });
      // grep returns 1 when no matches found — that's the success state.
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
    });

    it('check-in-card.tsx: tone words present only in REQ-11 allowlisted line', () => {
      const cmd = `grep -nE 'alert|warning|flag|violation|breach' ${path.join(
        SERVER_ROOT,
        'components',
        'manager',
        'check-in-card.tsx',
      )} | grep -Ev '^[0-9]+:[[:space:]]*not a flag\\.?[[:space:]]*$' || true`;
      const result = spawnSync('sh', ['-c', cmd], { encoding: 'utf8' });
      expect(result.stdout.trim()).toBe('');
    });
  });
});

// REPO_ROOT is currently unused but kept exported-shape for future reporter
// regression cases; silence the linter without leaking the symbol.
void REPO_ROOT;
