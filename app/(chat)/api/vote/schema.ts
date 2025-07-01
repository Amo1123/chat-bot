import { z } from 'zod';

/**
 * PATCH リクエストのボディのスキーマを定義します。
 * このスキーマは、/api/vote エンドポイントへの PATCH リクエストが受け取るデータの構造を検証します。
 */
export const patchRequestBodySchema = z.object({
  // 'chatId' は必須の文字列で、空であってはなりません。
  chatId: z.string().min(1, 'chatId is required.'),
  // 'messageId' は必須の文字列で、空であってはなりません。
  messageId: z.string().min(1, 'messageId is required.'),
  // 'type' は 'up' または 'down' のいずれかの文字列である必要があります。
  type: z.union([z.literal('up'), z.literal('down')]),
});

/**
 * patchRequestBodySchema から TypeScript の型を推論します。
 * これにより、リクエストボディのデータに型安全性がもたらされ、
 * 開発時のエラーを減らすことができます。
 */
export type PatchRequestBody = z.infer<typeof patchRequestBodySchema>;
