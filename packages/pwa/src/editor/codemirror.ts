import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { HighlightStyle, bracketMatching, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import {
  EditorView,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { codeVariables } from './codePalette.js';

/*
 * Editor de arquivos do workspace (CodeMirror 6). A interface é monocromática: as cores do texto vêm dos tokens
 * `--ui-*` de styles.css. A única cor de código é o realce de sintaxe, que lê as variáveis `--code-*` definidas
 * abaixo (palheta em codePalette.ts). Claro e escuro seguem o sistema sem JavaScript. Os estilos são injetados
 * pelo próprio CodeMirror; o CSP `style-src 'unsafe-inline'` do daemon permite isso.
 */

const MONO = "ui-monospace, 'SF Mono', Menlo, Consolas, monospace";

/** Fonte de 16px: abaixo disso o iOS dá zoom ao focar o editor. */
const EDITOR_FONT_SIZE = '16px';

const theme = EditorView.theme({
  '&': {
    color: 'var(--ui-foreground)',
    backgroundColor: 'transparent',
    fontSize: EDITOR_FONT_SIZE,
    height: '100%',
    // Segue o sistema: as variáveis `--code-*` são `light-dark()` (ver codePalette.ts).
    colorScheme: 'light dark',
    ...codeVariables(),
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: MONO,
    lineHeight: '1.5',
    scrollbarColor: 'var(--ui-border) transparent',
  },
  '.cm-content': {
    caretColor: 'var(--ui-foreground)',
    padding: '8px 0',
    fontSize: EDITOR_FONT_SIZE,
  },
  '.cm-line': { padding: '0 12px 0 4px' },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--ui-muted-foreground)',
    border: 'none',
    fontVariantNumeric: 'tabular-nums',
  },
  '.cm-gutterElement': { padding: '0 8px 0 12px' },
  '.cm-activeLine': {
    backgroundColor: 'color-mix(in oklab, var(--ui-foreground) 5%, transparent)',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'transparent',
    color: 'var(--ui-foreground)',
  },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    backgroundColor: 'color-mix(in oklab, var(--ui-foreground) 16%, transparent) !important',
  },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--ui-foreground)' },
});

/**
 * Realce de sintaxe. Cor só para o que ajuda a ler: palavras-chave, strings, números, tipos, funções,
 * propriedades, operadores. Comentários em cinza itálico. Títulos e links de markdown, e o erro, também usam cor.
 */
const highlight = HighlightStyle.define([
  {
    tag: [
      tags.keyword,
      tags.modifier,
      tags.controlKeyword,
      tags.definitionKeyword,
      tags.moduleKeyword,
      tags.operatorKeyword,
      tags.self,
    ],
    color: 'var(--code-keyword)',
  },
  { tag: [tags.string, tags.regexp, tags.special(tags.string)], color: 'var(--code-string)' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: 'var(--code-number)' },
  {
    tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment],
    color: 'var(--code-comment)',
    fontStyle: 'italic',
  },
  {
    tag: [tags.typeName, tags.className, tags.namespace, tags.tagName, tags.standard(tags.typeName)],
    color: 'var(--code-type)',
  },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.meta, tags.processingInstruction],
    color: 'var(--code-function)',
  },
  {
    tag: [tags.propertyName, tags.attributeName, tags.definition(tags.propertyName)],
    color: 'var(--code-property)',
  },
  { tag: [tags.operator, tags.derefOperator], color: 'var(--code-operator)' },
  { tag: tags.heading, color: 'var(--code-function)', fontWeight: '600' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: [tags.link, tags.url], color: 'var(--code-function)', textDecoration: 'underline' },
  { tag: tags.monospace, color: 'var(--code-string)' },
  { tag: tags.inserted, color: 'var(--code-string)' },
  { tag: tags.deleted, color: 'var(--code-invalid)' },
  { tag: tags.invalid, color: 'var(--code-invalid)', textDecoration: 'underline wavy' },
]);

/** Quebra de linha: um compartimento, para o botão trocar sem recriar o editor (e perder o desfazer). */
export const wrapCompartment = new Compartment();

/**
 * Linguagem do arquivo (parser e realce). Entra vazia e é trocada depois que o parser carrega (ver
 * `loadLanguage`), pelo compartimento: o editor não é recriado, e o desfazer continua.
 */
export const languageCompartment = new Compartment();

export interface EditorInput {
  /** Quebra de linha ligada no início. Depois, muda pelo compartimento. */
  wrapping: boolean;
  /** Ctrl/Cmd+S (teclado externo no iPad, ou no PC). */
  onSave(): void;
}

/** Extensões do editor para um arquivo: realce, desfazer, números de linha, sem correção automática do iOS. */
export function editorExtensions(input: EditorInput): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightActiveLine(),
    history(),
    drawSelection(),
    dropCursor(),
    bracketMatching(),
    EditorState.tabSize.of(2),
    indentUnit.of('  '),
    syntaxHighlighting(highlight),
    theme,
    languageCompartment.of([]),
    wrapCompartment.of(input.wrapping ? EditorView.lineWrapping : []),
    keymap.of([
      {
        key: 'Mod-s',
        preventDefault: true,
        run: () => {
          input.onSave();
          return true;
        },
      },
      ...defaultKeymap,
      ...historyKeymap,
    ]),
    // Código não é texto de mensagem: o teclado do iOS não deve corrigir nem maiusculizar.
    EditorView.contentAttributes.of({
      autocapitalize: 'off',
      autocorrect: 'off',
      spellcheck: 'false',
    }),
  ];
}
