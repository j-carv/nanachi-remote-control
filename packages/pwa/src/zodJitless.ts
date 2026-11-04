import { z } from 'zod';

// Sem JIT: o zod 4 testa `new Function` ao montar schemas, e a CSP do index.html (sem
// 'unsafe-eval') bloqueia isso com violação no console. Importe este módulo antes de qualquer schema.
z.config({ jitless: true });
