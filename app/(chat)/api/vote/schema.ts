import { z } from 'zod';
import { type Message } from 'ai'; // 'ai' SDKのMessage型をインポートする必要があるかもしれません

/**
 * POST リクエストのボディのスキーマを定義します。
 * これは /api/chat エンドポイントへの POST リクエストが受け取るデータの構造を検証します。
 */
export const postRequestBodySchema = z.object({
  // チャットIDは必須の文字列
  id: z.string().min(1, 'Chat ID is required.'),
  // メッセージは 'ai' SDK の Message 型に合う構造を持つオブジェクト
  // 実際の Message 型の構造に合わせて調整してください
  message: z.object({
    id: z.string(),
    role: z.string(), // 'user' など
    content: z.string().optional(), // テキストコンテンツ
    parts: z.array(z.any()), // MessagePart の配列
    experimental_attachments: z.array(z.any()).optional(), // 添付ファイルがある場合
    // 他の Message プロパティがあればここに追加
  }),
  // 選択されたチャットモデルは必須の文字列
  selectedChatModel: z.string().min(1, 'Selected chat model is required.'),
  // 選択された可視性タイプは必須の文字列
  selectedVisibilityType: z.string().min(1, 'Selected visibility type is required.'),
});

/**
 * postRequestBodySchema から TypeScript の型を推論します。
 */
export type PostRequestBody = z.infer<typeof postRequestBodySchema>;
