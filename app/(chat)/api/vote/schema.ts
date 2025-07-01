import { z } from 'zod';

// PATCH リクエストのボディのスキーマを定義します。
// これは /api/vote エンドポイントへの PATCH リクエストが受け取るデータの構造を検証します。
export const patchRequestBodySchema = z.object({
  chatId: z.string().min(1, 'chatId is required.'), // チャットIDは必須の文字列
  messageId: z.string().min(1, 'messageId is required.'), // メッセージIDは必須の文字列
  type: z.union([z.literal('up'), z.literal('down')]), // 投票タイプは 'up' または 'down' のいずれか
});

// スキーマから TypeScript の型を推論します。
// これにより、リクエストボディのデータに型安全性がもたらされます。
export type PatchRequestBody = z.infer<typeof patchRequestBodySchema>;
