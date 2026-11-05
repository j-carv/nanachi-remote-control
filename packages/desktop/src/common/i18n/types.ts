/**
 * The shape of a dictionary: the same keys as `T`, every leaf a plain string. The pt-BR dictionary is the model; `en` and `es`
 * are annotated with `Strings<typeof ptBR...>`, so a missing or an extra key fails the type check, not only the tests.
 */
export type Strings<T> = { [K in keyof T]: T[K] extends string ? string : Strings<T[K]> };
