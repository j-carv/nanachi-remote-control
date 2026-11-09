import { z } from 'zod';

/** Public attachment metadata. Stored filesystem paths are never part of device events. */
export const FileInfoSchema = z.object({
  fileId: z.string().min(1),
  name: z.string().min(1),
  mime: z.string().min(1),
  size: z.number().int().nonnegative(),
});

export type FileInfo = z.infer<typeof FileInfoSchema>;
