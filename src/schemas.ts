import { z } from 'zod';

// ============================================
// COMMON SCHEMAS
// ============================================

export const IdempotencyKeySchema = z.string().optional().describe(
  'Unique idempotency key to prevent duplicate operations. Use the same key for retries. Format: client-generated UUID or timestamp-based string.'
);

// ============================================
// CARD SCHEMAS
// ============================================

export const GetCardSchema = z.object({
  card_id: z.number().positive().int().describe('The ID of the card to retrieve'),
});

export const CreateCardSchema = z.object({
  title: z.string().min(1).max(500).describe('The title of the card'),
  board_id: z.number().positive().int().describe('The ID of the board where the card will be created'),
  column_id: z.number().positive().int().optional().describe('The ID of the column (optional)'),
  lane_id: z.number().positive().int().optional().describe('The ID of the lane (optional)'),
  description: z.string().optional().describe('The description of the card (optional)'),
  type_id: z.number().positive().int().optional().describe('The type ID of the card (optional)'),
  size: z.number().min(0).optional().describe('The size/estimate of the card (optional)'),
  asap: z.boolean().optional().describe('Mark as ASAP (optional)'),
  owner_id: z.number().positive().int().optional().describe('The ID of the card owner (optional)'),
  due_date: z.string().optional().describe('Due date in ISO format (optional)'),
  idempotency_key: IdempotencyKeySchema,
});

export const UpdateCardSchema = z.object({
  card_id: z.number().positive().int().describe('The ID of the card to update'),
  title: z.string().min(1).max(500).optional().describe('The new title (optional)'),
  description: z.string().optional().describe('The new description (optional)'),
  state: z.number().optional().describe('The new state (optional)'),
  column_id: z.number().positive().int().optional().describe('Move to this column ID (optional)'),
  lane_id: z.number().positive().int().optional().describe('Move to this lane ID (optional)'),
  type_id: z.number().positive().int().optional().describe('The new type ID (optional)'),
  size: z.number().min(0).optional().describe('The new size/estimate (optional)'),
  asap: z.boolean().optional().describe('Mark as ASAP (optional)'),
  owner_id: z.number().positive().int().optional().describe('The new owner ID (optional)'),
  due_date: z.string().optional().describe('New due date in ISO format (optional)'),
  idempotency_key: IdempotencyKeySchema,
});

export const DeleteCardSchema = z.object({
  card_id: z.number().positive().int().describe('The ID of the card to delete'),
});

export const SearchCardsSchema = z.object({
  // Text search
  query: z.string().optional().describe('Search query for partial case-insensitive matching'),

  // Basic filters
  space_id: z.number().optional().describe('Filter by space ID. Omit for default space, 0 for all spaces'),
  board_id: z.number().positive().int().optional().describe('Filter by board ID (RECOMMENDED to avoid large responses)'),
  column_id: z.number().positive().int().optional().describe('Filter by column ID (optional)'),
  lane_id: z.number().positive().int().optional().describe('Filter by lane ID (optional)'),
  title: z.string().optional().describe('Filter by title (optional)'),
  state: z.number().optional().describe('Filter by state: 1=queued, 2=inProgress, 3=done (optional)'),
  owner_id: z.number().positive().int().optional().describe('Filter by owner ID (optional)'),
  type_id: z.number().positive().int().optional().describe('Filter by card type ID (optional)'),
  condition: z.number().min(1).max(2).optional().describe('Filter by condition: 1=active (default), 2=archived'),

  // Date filters (ISO 8601 format)
  created_before: z.string().optional().describe('Created before date (ISO 8601 format, e.g., "2025-10-11T23:59:59Z")'),
  created_after: z.string().optional().describe('Created after date (ISO 8601 format, e.g., "2025-10-01T00:00:00Z")'),
  updated_before: z.string().optional().describe('Updated before date (ISO 8601 format)'),
  updated_after: z.string().optional().describe('Updated after date (ISO 8601 format)'),
  due_date_before: z.string().optional().describe('Due date before (ISO 8601 format)'),
  due_date_after: z.string().optional().describe('Due date after (ISO 8601 format)'),
  last_moved_to_done_at_before: z.string().optional().describe('Last moved to done before date (ISO 8601 format)'),
  last_moved_to_done_at_after: z.string().optional().describe('Last moved to done after date (ISO 8601 format)'),

  // Boolean flags
  asap: z.boolean().optional().describe('Filter by ASAP marker (true=only ASAP cards)'),
  archived: z.boolean().optional().describe('Filter by archived flag'),
  overdue: z.boolean().optional().describe('Filter by overdue cards (true=only overdue)'),
  done_on_time: z.boolean().optional().describe('Filter by completed on time (true=only done on time)'),
  with_due_date: z.boolean().optional().describe('Filter cards with due date set (true=only with due date)'),

  // Multiple IDs (comma-separated strings)
  owner_ids: z.string().optional().describe('Filter by multiple owner IDs (comma-separated, e.g., "123,456,789")'),
  member_ids: z.string().optional().describe('Filter by member IDs (comma-separated)'),
  column_ids: z.string().optional().describe('Filter by multiple column IDs (comma-separated)'),
  type_ids: z.string().optional().describe('Filter by multiple type IDs (comma-separated)'),
  tag_ids: z.string().optional().describe('Filter by tag IDs (comma-separated)'),

  // Exclude filters
  exclude_board_ids: z.string().optional().describe('Exclude board IDs (comma-separated)'),
  exclude_owner_ids: z.string().optional().describe('Exclude owner IDs (comma-separated)'),
  exclude_card_ids: z.string().optional().describe('Exclude card IDs (comma-separated)'),

  // Sorting and pagination
  sort_by: z.enum(['created', 'updated', 'title']).optional().describe('Sort field (default: created)'),
  sort_direction: z.enum(['asc', 'desc']).optional().describe('Sort direction (default: desc)'),
  limit: z.number().positive().int().max(20).optional().describe('Maximum number of cards to return (default: 10, max: 20 for context economy)'),
  skip: z.number().min(0).int().optional().describe('Number of cards to skip for pagination (default: 0)'),
});

export const GetSpaceCardsSchema = z.object({
  space_id: z.number().positive().int().describe('The ID of the space'),
  limit: z.number().positive().int().max(20).optional().describe('Maximum number of cards (default: 10, max: 20)'),
  skip: z.number().min(0).int().optional().describe('Number of cards to skip (default: 0)'),
  condition: z.number().min(1).max(2).optional().describe('Filter by condition: 1=active (default), 2=archived'),
});

export const GetBoardCardsSchema = z.object({
  board_id: z.number().positive().int().describe('The ID of the board'),
  limit: z.number().positive().int().max(20).optional().describe('Maximum number of cards (default: 10, max: 20)'),
  skip: z.number().min(0).int().optional().describe('Number of cards to skip (default: 0)'),
  condition: z.number().min(1).max(2).optional().describe('Filter by condition: 1=active (default), 2=archived'),
});

// ============================================
// COMMENT SCHEMAS
// ============================================

export const GetCardCommentsSchema = z.object({
  card_id: z.number().positive().int().describe('The ID of the card'),
});

export const CreateCommentSchema = z.object({
  card_id: z.number().positive().int().describe('The ID of the card'),
  text: z.string().min(1).describe('The comment text'),
  idempotency_key: IdempotencyKeySchema,
});

export const UpdateCommentSchema = z.object({
  card_id: z.number().positive().int().describe('The ID of the card'),
  comment_id: z.number().positive().int().describe('The ID of the comment to update'),
  text: z.string().min(1).describe('The new comment text'),
  idempotency_key: IdempotencyKeySchema,
});

export const DeleteCommentSchema = z.object({
  card_id: z.number().positive().int().describe('The ID of the card'),
  comment_id: z.number().positive().int().describe('The ID of the comment to delete'),
});

// ============================================
// SPACE SCHEMAS
// ============================================

export const GetSpaceSchema = z.object({
  space_id: z.number().positive().int().describe('The ID of the space'),
});

// ============================================
// BOARD SCHEMAS
// ============================================

export const ListBoardsSchema = z.object({
  space_id: z.number().positive().int().optional().describe('Filter by space ID (optional)'),
});

export const GetBoardSchema = z.object({
  board_id: z.number().positive().int().describe('The ID of the board'),
});

// ============================================
// BOARD СПРАВОЧНИКИ (COLUMNS, LANES, TYPES)
// ============================================

export const ListColumnsSchema = z.object({
  board_id: z.number().positive().int().describe('The ID of the board'),
});

export const ListLanesSchema = z.object({
  board_id: z.number().positive().int().describe('The ID of the board'),
});

export const ListTypesSchema = z.object({
  board_id: z.number().positive().int().describe('The ID of the board'),
});

// ============================================
// USER SCHEMAS
// ============================================

export const ListUsersSchema = z.object({
  query: z.string().optional().describe('Search query to filter users by email and full_name (server-side filtering)'),
  limit: z.number().positive().int().max(100).optional().describe('Maximum number of users to return (default: 100)'),
  offset: z.number().min(0).int().optional().describe('Number of records to skip for pagination (default: 0)'),
});

// GetCurrentUser has no parameters, so no schema needed

// ============================================
// LOGGING SCHEMAS
// ============================================

export const SetLogLevelSchema = z.object({
  level: z.enum(['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency', 'off']).describe('New log level'),
  enable_mcp_logs: z.boolean().optional().describe('Enable/disable MCP client logs'),
  enable_file_logs: z.boolean().optional().describe('Enable/disable file logs'),
  enable_request_logs: z.boolean().optional().describe('Enable/disable detailed request logging'),
  enable_metrics: z.boolean().optional().describe('Enable/disable performance metrics collection'),
});

// ============================================
// TYPES FOR VALIDATED DATA
// ============================================

export type GetCardArgs = z.infer<typeof GetCardSchema>;
export type CreateCardArgs = z.infer<typeof CreateCardSchema>;
export type UpdateCardArgs = z.infer<typeof UpdateCardSchema>;
export type DeleteCardArgs = z.infer<typeof DeleteCardSchema>;
export type SearchCardsArgs = z.infer<typeof SearchCardsSchema>;
export type GetSpaceCardsArgs = z.infer<typeof GetSpaceCardsSchema>;
export type GetBoardCardsArgs = z.infer<typeof GetBoardCardsSchema>;
export type GetCardCommentsArgs = z.infer<typeof GetCardCommentsSchema>;
export type CreateCommentArgs = z.infer<typeof CreateCommentSchema>;
export type UpdateCommentArgs = z.infer<typeof UpdateCommentSchema>;
export type DeleteCommentArgs = z.infer<typeof DeleteCommentSchema>;
export type GetSpaceArgs = z.infer<typeof GetSpaceSchema>;
export type ListBoardsArgs = z.infer<typeof ListBoardsSchema>;
export type GetBoardArgs = z.infer<typeof GetBoardSchema>;
export type ListColumnsArgs = z.infer<typeof ListColumnsSchema>;
export type ListLanesArgs = z.infer<typeof ListLanesSchema>;
export type ListTypesArgs = z.infer<typeof ListTypesSchema>;
export type ListUsersArgs = z.infer<typeof ListUsersSchema>;
export type SetLogLevelArgs = z.infer<typeof SetLogLevelSchema>;
