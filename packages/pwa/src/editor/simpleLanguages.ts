import { simpleMode } from '@codemirror/legacy-modes/mode/simple-mode';

/*
 * Gramáticas pequenas que o @codemirror/legacy-modes não traz (INI, Batch, Makefile, .gitignore, GraphQL). Usam o
 * `simpleMode`: uma lista de regex por token, sem parser completo. Os nomes de token são os do modo legado
 * (`header`, `property`, `variable-2`...), que o CodeMirror mapeia para as tags de realce.
 */

/** INI, .env, .editorconfig, .npmrc: `[seção]`, `chave = valor`, comentários com `;` ou `#`. */
export const ini = simpleMode({
  start: [
    { regex: /[;#].*/, token: 'comment' },
    { regex: /\[[^\]]*\]/, token: 'header' },
    { regex: /[^=:\s][^=:]*?(?=\s*[=:])/, token: 'property' },
    { regex: /[=:]/, token: 'operator' },
    { regex: /"(?:[^"\\]|\\.)*"?/, token: 'string' },
  ],
});

/** Batch (.bat, .cmd): REM e `::`, variáveis `%X%`, palavras de comando, rótulos `:nome`. */
export const batch = simpleMode({
  start: [
    { regex: /\brem\b.*/i, token: 'comment' },
    { regex: /::.*/, token: 'comment' },
    { regex: /%[^%\s]+%|%~?\d/, token: 'variable-2' },
    { regex: /"(?:[^"\\]|\\.)*"?/, token: 'string' },
    {
      regex:
        /\b(?:echo|set|setlocal|endlocal|if|else|for|in|do|goto|call|exit|cd|copy|del|dir|mkdir|rmdir|move|pushd|popd|start|pause|title|shift|not|exist|defined|errorlevel)\b/i,
      token: 'keyword',
    },
    { regex: /:[A-Za-z_][\w.-]*/, token: 'def' },
    { regex: /\b\d+\b/, token: 'number' },
    { regex: /[&|<>@]/, token: 'operator' },
  ],
});

/** Makefile: alvos, `$(VAR)`, diretivas, comentários com `#`. As receitas (linhas com tab) ficam em texto puro. */
export const makefile = simpleMode({
  start: [
    { regex: /#.*/, token: 'comment' },
    { regex: /[^\s:#=]+(?=\s*:(?!=))/, token: 'def' },
    { regex: /\$[({][^)}]*[)}]|\$[@<^+?*]/, token: 'variable-2' },
    { regex: /"(?:[^"\\]|\\.)*"?/, token: 'string' },
    { regex: /\.PHONY\b|\b(?:ifeq|ifneq|ifdef|ifndef|else|endif|define|endef|include|export|override)\b/, token: 'keyword' },
    { regex: /[:?+]?=|:/, token: 'operator' },
  ],
});

/** .gitignore (e .dockerignore, .npmignore): comentários, negação `!`, curingas `*`, `**`, `?`. */
export const gitignore = simpleMode({
  start: [
    { regex: /#.*/, token: 'comment' },
    { regex: /!/, token: 'operator' },
    { regex: /\*\*?|\?/, token: 'operator' },
  ],
});

/** GraphQL: operações e definições, `$variável`, `@diretiva`, tipos com maiúscula, strings e comentários `#`. */
export const graphql = simpleMode({
  start: [
    { regex: /#.*/, token: 'comment' },
    { regex: /"(?:[^"\\]|\\.)*"?/, token: 'string' },
    { regex: /\$\w+/, token: 'variable-2' },
    { regex: /@\w+/, token: 'meta' },
    {
      regex:
        /\b(?:query|mutation|subscription|fragment|on|type|input|enum|interface|union|scalar|schema|extend|directive|implements|repeatable)\b/,
      token: 'keyword',
    },
    { regex: /\b(?:true|false|null)\b/, token: 'atom' },
    { regex: /-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/, token: 'number' },
    { regex: /\b[A-Z]\w*\b/, token: 'type' },
    { regex: /[!:=|&]/, token: 'operator' },
  ],
});
