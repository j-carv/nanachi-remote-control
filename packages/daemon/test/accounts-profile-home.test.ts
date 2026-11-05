import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ACCOUNT_ADAPTERS } from '../src/accounts/adapters.js';
import { prepareProfile, removeProfileHome } from '../src/accounts/profile-home.js';
import { removeTempDir } from './temp.js';

const claude = ACCOUNT_ADAPTERS.claude;
if (claude === undefined) throw new Error('adaptador claude ausente');
const codex = ACCOUNT_ADAPTERS.codex;
if (codex === undefined) throw new Error('adaptador codex ausente');

let root: string;
let nanachi: string;
let principal: string;
let profile: string;
let warnings: string[];
const warn = (message: string): void => {
  warnings.push(message);
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nanachi-profile-'));
  nanachi = join(root, 'nanachi');
  principal = join(root, 'principal');
  profile = join(nanachi, 'accounts', 'claude', 'a1');
  warnings = [];
  await mkdir(join(principal, 'projects'), { recursive: true });
  await writeFile(join(principal, 'projects', 'a.jsonl'), 'principal');
});

afterEach(async () => {
  await removeTempDir(root);
});

describe('prepareProfile', () => {
  it('liga as pastas compartilhadas por junção e cria no principal a que faltar (vazia)', async () => {
    await prepareProfile(claude, principal, profile, { warn });

    expect((await lstat(join(profile, 'projects'))).isSymbolicLink()).toBe(true);
    expect(await readFile(join(profile, 'projects', 'a.jsonl'), 'utf8')).toBe('principal');
    expect((await stat(join(principal, 'plans'))).isDirectory()).toBe(true);
    expect((await lstat(join(profile, 'plans'))).isSymbolicLink()).toBe(true);
    expect(warnings).toEqual([]);
  });

  it('um segundo preparo com a junção certa não muda nada e não avisa', async () => {
    await prepareProfile(claude, principal, profile, { warn });
    await prepareProfile(claude, principal, profile, { warn });
    expect(await readlink(join(profile, 'projects'))).toContain('principal');
    expect(warnings).toEqual([]);
  });

  it('pasta real no lugar de uma compartilhada fica como está, com aviso', async () => {
    await mkdir(join(profile, 'skills'), { recursive: true });
    await writeFile(join(profile, 'skills', 'mine.txt'), 'do perfil');

    await prepareProfile(claude, principal, profile, { warn });

    expect((await lstat(join(profile, 'skills'))).isSymbolicLink()).toBe(false);
    expect(await readFile(join(profile, 'skills', 'mine.txt'), 'utf8')).toBe('do perfil');
    expect(warnings).toHaveLength(1);
  });

  it('junção que aponta para outro lugar fica como está, com aviso', async () => {
    const elsewhere = join(root, 'elsewhere');
    await mkdir(elsewhere, { recursive: true });
    await mkdir(profile, { recursive: true });
    await symlink(elsewhere, join(profile, 'hooks'), 'junction');

    await prepareProfile(claude, principal, profile, { warn });

    expect(await readlink(join(profile, 'hooks'))).toContain('elsewhere');
    expect(warnings).toHaveLength(1);
  });

  it('copia os arquivos compartilhados sobrescrevendo; arquivo que falta no principal deixa a cópia do perfil', async () => {
    await writeFile(join(principal, 'settings.json'), '{"model":"new"}');
    await writeFile(join(principal, 'CLAUDE.md'), 'instrucoes');
    await mkdir(profile, { recursive: true });
    await writeFile(join(profile, 'settings.json'), '{"model":"old"}');
    await writeFile(join(profile, 'keybindings.json'), 'so do perfil');
    await writeFile(join(profile, 'private.json'), 'segredo do perfil');

    await prepareProfile(claude, principal, profile, { warn });

    expect(await readFile(join(profile, 'settings.json'), 'utf8')).toBe('{"model":"new"}');
    expect(await readFile(join(profile, 'CLAUDE.md'), 'utf8')).toBe('instrucoes');
    expect(await readFile(join(profile, 'keybindings.json'), 'utf8')).toBe('so do perfil');
    expect(await readFile(join(profile, 'private.json'), 'utf8')).toBe('segredo do perfil');
  });

  it('mescla .claude.json: mantém oauthAccount, userID e as demais chaves do perfil; copia só as compartilhadas', async () => {
    const stateFile = join(principal, '.claude.json');
    await writeFile(
      stateFile,
      JSON.stringify({
        mcpServers: { x: { command: 'x' } },
        projects: { 'C:\\projetos': {} },
        hasCompletedOnboarding: true,
        lastOnboardingVersion: '2.1.0',
        theme: 'dark',
        numStartups: 99,
      }),
    );
    await mkdir(profile, { recursive: true });
    await writeFile(
      join(profile, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'a@exemplo.com' }, userID: 'u-perfil', mcpServers: {}, numStartups: 3 }),
    );

    await prepareProfile(claude, principal, profile, { warn, principalStateFile: stateFile });

    const merged: unknown = JSON.parse(await readFile(join(profile, '.claude.json'), 'utf8'));
    expect(merged).toEqual({
      oauthAccount: { emailAddress: 'a@exemplo.com' },
      userID: 'u-perfil',
      mcpServers: { x: { command: 'x' } },
      projects: { 'C:\\projetos': {} },
      hasCompletedOnboarding: true,
      lastOnboardingVersion: '2.1.0',
      theme: 'dark',
      numStartups: 3,
    });
    expect(warnings).toEqual([]);
  });

  it('sem .claude.json no principal, ou com JSON inválido, não mexe no arquivo do perfil e avisa', async () => {
    await mkdir(profile, { recursive: true });
    await writeFile(join(profile, '.claude.json'), '{"userID":"u"}');

    await prepareProfile(claude, principal, profile, { warn, principalStateFile: join(principal, 'nao-existe.json') });
    expect(await readFile(join(profile, '.claude.json'), 'utf8')).toBe('{"userID":"u"}');

    await writeFile(join(principal, 'ruim.json'), '{nao e json');
    await prepareProfile(claude, principal, profile, { warn, principalStateFile: join(principal, 'ruim.json') });
    expect(await readFile(join(profile, '.claude.json'), 'utf8')).toBe('{"userID":"u"}');

    expect(warnings).toHaveLength(2);
  });

  it('JSON inválido no perfil não é sobrescrito: aviso e arquivo intacto', async () => {
    const stateFile = join(principal, '.claude.json');
    await writeFile(stateFile, '{"theme":"dark"}');
    await mkdir(profile, { recursive: true });
    await writeFile(join(profile, '.claude.json'), '{quebrado');

    await prepareProfile(claude, principal, profile, { warn, principalStateFile: stateFile });

    expect(await readFile(join(profile, '.claude.json'), 'utf8')).toBe('{quebrado');
    expect(warnings).toHaveLength(1);
  });
});

describe('prepareProfile: pasta principal', () => {
  it('pasta principal inexistente: não é criada, nenhuma junção nasce e há um aviso', async () => {
    const missing = join(root, 'principal-que-nao-existe');

    await prepareProfile(claude, missing, profile, { warn });

    await expect(stat(missing)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await stat(profile)).isDirectory()).toBe(true);
    expect(await readdir(profile)).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(missing);
  });

  it('pasta principal inexistente ainda mescla o .claude.json (o arquivo de estado fica fora da pasta)', async () => {
    const missing = join(root, 'principal-que-nao-existe');
    const stateFile = join(root, 'estado.json');
    await writeFile(stateFile, JSON.stringify({ theme: 'dark' }));

    await prepareProfile(claude, missing, profile, { warn, principalStateFile: stateFile });

    expect(JSON.parse(await readFile(join(profile, '.claude.json'), 'utf8'))).toEqual({ theme: 'dark' });
    await expect(stat(missing)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('as pastas do sandbox do codex só são ligadas se já existem na principal; as outras faltantes são criadas', async () => {
    const principalCodex = join(root, 'principal-codex');
    await mkdir(join(principalCodex, '.sandbox'), { recursive: true });
    const codexProfile = join(nanachi, 'accounts', 'codex', 'c1');

    await prepareProfile(codex, principalCodex, codexProfile, { warn });

    expect((await lstat(join(codexProfile, '.sandbox'))).isSymbolicLink()).toBe(true);
    for (const name of ['.sandbox-bin', '.sandbox-secrets']) {
      await expect(stat(join(principalCodex, name))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(lstat(join(codexProfile, name))).rejects.toMatchObject({ code: 'ENOENT' });
    }
    for (const name of ['sessions', 'archived_sessions', 'skills', 'prompts', 'rules', 'memories']) {
      expect((await stat(join(principalCodex, name))).isDirectory()).toBe(true);
      expect((await lstat(join(codexProfile, name))).isSymbolicLink()).toBe(true);
    }
    expect(warnings).toEqual([]);
  });

  it('preparos simultâneos do mesmo perfil, sem fila, não falham com EEXIST e deixam todas as junções certas', async () => {
    // O Windows cria a junção em dois passos (pasta, depois o ponto de reparse): um preparo concorrente pode ver a pasta
    // vazia e avisar. O que não pode acontecer é falhar, nem apagar ou trocar a junção do outro.
    await Promise.all(Array.from({ length: 8 }, () => prepareProfile(claude, principal, profile, { warn })));

    for (const name of claude.sharedDirs) {
      expect((await lstat(join(profile, name))).isSymbolicLink()).toBe(true);
      expect(await readlink(join(profile, name))).toContain('principal');
    }
  });
});

describe('prepareProfile: .claude.json', () => {
  async function fileIdentity(file: string): Promise<{ ino: bigint; mtimeNs: bigint }> {
    const info = await stat(file, { bigint: true });
    return { ino: info.ino, mtimeNs: info.mtimeNs };
  }

  it('chaves compartilhadas já iguais às da principal: o arquivo do perfil não é reescrito', async () => {
    const stateFile = join(principal, '.claude.json');
    await writeFile(stateFile, JSON.stringify({ theme: 'dark', projects: { a: { x: 1 } }, numStartups: 9 }));
    await mkdir(profile, { recursive: true });
    const profileFile = join(profile, '.claude.json');
    await writeFile(profileFile, JSON.stringify({ projects: { a: { x: 1 } }, theme: 'dark', userID: 'u', numStartups: 1 }));
    const before = await fileIdentity(profileFile);
    const text = await readFile(profileFile, 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 20));

    await prepareProfile(claude, principal, profile, { warn, principalStateFile: stateFile });

    expect(await fileIdentity(profileFile)).toEqual(before);
    expect(await readFile(profileFile, 'utf8')).toBe(text);
    expect((await readdir(profile)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('chave compartilhada ausente na principal sai do perfil (espelho), e as outras chaves do perfil ficam', async () => {
    const stateFile = join(principal, '.claude.json');
    await writeFile(stateFile, JSON.stringify({ theme: 'dark' }));
    await mkdir(profile, { recursive: true });
    await writeFile(
      join(profile, '.claude.json'),
      JSON.stringify({ theme: 'light', mcpServers: { velho: {} }, oauthAccount: { emailAddress: 'a@exemplo.com' } }),
    );

    await prepareProfile(claude, principal, profile, { warn, principalStateFile: stateFile });

    expect(JSON.parse(await readFile(join(profile, '.claude.json'), 'utf8'))).toEqual({
      theme: 'dark',
      oauthAccount: { emailAddress: 'a@exemplo.com' },
    });
  });

  it('uma chave que difere reescreve o arquivo', async () => {
    const stateFile = join(principal, '.claude.json');
    await writeFile(stateFile, JSON.stringify({ theme: 'dark' }));
    await mkdir(profile, { recursive: true });
    const profileFile = join(profile, '.claude.json');
    await writeFile(profileFile, JSON.stringify({ theme: 'light', userID: 'u' }));

    await prepareProfile(claude, principal, profile, { warn, principalStateFile: stateFile });

    expect(JSON.parse(await readFile(profileFile, 'utf8'))).toEqual({ theme: 'dark', userID: 'u' });
  });

  it('sem nada compartilhado para copiar e sem arquivo no perfil: nenhum arquivo é criado', async () => {
    const stateFile = join(principal, '.claude.json');
    await writeFile(stateFile, JSON.stringify({ numStartups: 4 }));

    await prepareProfile(claude, principal, profile, { warn, principalStateFile: stateFile });

    await expect(stat(join(profile, '.claude.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('removeProfileHome', () => {
  it('um arquivo dentro de uma pasta compartilhada (junção) do principal sobrevive à remoção do perfil', async () => {
    await prepareProfile(claude, principal, profile, { warn });
    await mkdir(profile, { recursive: true });

    await removeProfileHome(nanachi, 'claude', profile);

    expect(await readFile(join(principal, 'projects', 'a.jsonl'), 'utf8')).toBe('principal');
    expect((await stat(join(principal, 'projects'))).isDirectory()).toBe(true);
    await expect(stat(profile)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('remove os arquivos privados e a própria pasta do perfil', async () => {
    await prepareProfile(claude, principal, profile, { warn });
    await writeFile(join(profile, 'oauth.json'), 'privado');
    await mkdir(join(profile, 'sub'), { recursive: true });
    await writeFile(join(profile, 'sub', 'x.txt'), 'x');

    await removeProfileHome(nanachi, 'claude', profile);

    await expect(stat(profile)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(principal)).toContain('projects');
  });

  it('arquivo somente leitura dentro do perfil também é removido', async () => {
    await prepareProfile(claude, principal, profile, { warn });
    await mkdir(join(profile, 'sub'), { recursive: true });
    const locked = join(profile, 'sub', 'travado.txt');
    await writeFile(locked, 'x');
    await chmod(locked, 0o444);

    await removeProfileHome(nanachi, 'claude', profile);

    await expect(stat(profile)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(principal, 'projects', 'a.jsonl'), 'utf8')).toBe('principal');
  });

  it('pasta de perfil ausente não é erro', async () => {
    await expect(removeProfileHome(nanachi, 'claude', profile)).resolves.toBeUndefined();
  });

  it('recusa caminhos fora de accounts/<agente>/<conta> e não apaga nada', async () => {
    await prepareProfile(claude, principal, profile, { warn });
    const outside = [
      principal,
      join(nanachi, 'accounts', 'claude'),
      join(nanachi, 'accounts', 'codex', 'a1'),
      join(nanachi, 'accounts', 'claude', '..', 'codex', 'a1'),
      join(nanachi, 'accounts', 'claude', 'a1', 'dentro'),
      join(nanachi, 'accounts', 'claude', '..', '..', 'principal'),
    ];
    for (const path of outside) {
      await expect(removeProfileHome(nanachi, 'claude', path)).rejects.toThrow();
    }
    expect(await readFile(join(principal, 'projects', 'a.jsonl'), 'utf8')).toBe('principal');
  });
});
