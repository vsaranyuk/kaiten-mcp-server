#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  Tool,
  ResourceTemplate,
  Prompt,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { config, safeLog } from './config.js';
import { cache } from './cache.js';
import { logger, LogLevel } from './logging/index.js';
import {
  KaitenClient,
  CreateCardParams,
  UpdateCardParams,
  KaitenCard,
  KaitenUser,
  KaitenSpace,
  KaitenBoard,
  KaitenComment,
  KaitenError,
} from './kaiten-client.js';
import {
  GetCardSchema,
  CreateCardSchema,
  UpdateCardSchema,
  DeleteCardSchema,
  SearchCardsSchema,
  GetSpaceCardsSchema,
  GetBoardCardsSchema,
  GetCardCommentsSchema,
  CreateCommentSchema,
  UpdateCommentSchema,
  DeleteCommentSchema,
  GetSpaceSchema,
  ListBoardsSchema,
  GetBoardSchema,
  ListColumnsSchema,
  ListLanesSchema,
  ListTypesSchema,
  ListUsersSchema,
  SetLogLevelSchema,
} from './schemas.js';
import {
  truncateResponse,
  applyCardVerbosity,
  applyUserVerbosity,
  applyBoardVerbosity,
  applyResponseFormat,
} from './utils.js';

// Config is loaded and validated in config.ts
const API_URL = config.KAITEN_API_URL;
const API_TOKEN = config.KAITEN_API_TOKEN;
const DEFAULT_SPACE_ID = config.KAITEN_DEFAULT_SPACE_ID;

if (DEFAULT_SPACE_ID) {
  safeLog.info(`Using default space ID: ${DEFAULT_SPACE_ID}`);
}

// Initialize Kaiten client (with retry, backoff, concurrency control)
const kaitenClient = new KaitenClient(API_URL, API_TOKEN);

// Initialize MCP logger (will be set when server is ready)
const mcpLogger = logger.getMCPLogger();

// ============================================
// HELPER FUNCTIONS (IMPROVED TYPING)
// ============================================

function simplifyUser(user: KaitenUser) {
  return {
    id: user.id,
    full_name: user.full_name,
    email: user.email,
    username: user.username,
    activated: user.activated
  };
}

function simplifySpace(space: KaitenSpace) {
  return {
    id: space.id,
    title: space.title,
    archived: space.archived,
    boards: space.boards?.map((b) => ({
      id: b.id,
      title: b.title
    })) || []
  };
}

function simplifyComment(comment: KaitenComment) {
  return {
    id: comment.id,
    text: comment.text,
    created: comment.created,
    updated: comment.updated,
    author_id: comment.author?.id,
    author_name: comment.author?.full_name
  };
}

interface SimplifiedCard {
  id: number;
  title: string;
  url: string;
  description: string | null;
  created?: string;
  updated?: string;
  state?: number;
  owner_id: number | null;
  owner_name: string | null;
  board_id?: number;
  board_title: string | null;
  column_id?: number;
  column_title: string | null;
  lane_id?: number;
  lane_title: string | null;
  type_id?: number;
  type_name: string | null;
  comments_total: number;
  last_comment_date: string | null;
  tags: string[];
  members: string[];
  asap: boolean;
  blocked: boolean;
  block_reason: string | null;
  blocked_at: string | null;
  blocker_name: string | null;
  archived: boolean;
  size: number | null;
  due_date: string | null;
}

function simplifyCard(card: KaitenCard): SimplifiedCard {
  const baseUrl = API_URL!.replace('/api/latest', '');
  const spaceId = card.space_id || card.board?.space_id || DEFAULT_SPACE_ID || '';
  const cardUrl = `${baseUrl}/space/${spaceId}/card/${card.id}`;

  const blockInfo = card.blocked && card.blockers && card.blockers.length > 0
    ? {
        blocked: true,
        block_reason: card.blockers[0].reason || null,
        blocked_at: card.blockers[0].created || null,
        blocker_name: card.blockers[0].blocker?.full_name || null
      }
    : { blocked: false, block_reason: null, blocked_at: null, blocker_name: null };

  const lastCommentDate = card.comment_last_added_at || null;

  return {
    id: card.id,
    title: card.title,
    url: cardUrl,
    description: card.description || null,
    created: card.created,
    updated: card.updated,
    state: card.state,
    owner_id: card.owner?.id || null,
    owner_name: card.owner?.full_name || null,
    board_id: card.board_id,
    board_title: card.board?.title || null,
    column_id: card.column_id,
    column_title: card.column?.title || null,
    lane_id: card.lane_id,
    lane_title: card.lane?.title || null,
    type_id: card.type_id,
    type_name: card.type?.name || null,
    comments_total: card.comments_total || 0,
    last_comment_date: lastCommentDate,
    tags: card.tags?.map((t) => t.name) || [],
    members: card.members?.map((m) => m.full_name) || [],
    asap: card.asap || false,
    ...blockInfo,
    archived: !!card.archived,
    size: card.size || null,
    due_date: card.due_date || null
  };
}

// Compact version for search results - only essential fields
function simplifyCardCompact(card: KaitenCard) {
  const baseUrl = API_URL!.replace('/api/latest', '');
  const spaceId = card.space_id || card.board?.space_id || DEFAULT_SPACE_ID || '';
  const cardUrl = `${baseUrl}/space/${spaceId}/card/${card.id}`;

  return {
    id: card.id,
    title: card.title,
    url: cardUrl,
    board_title: card.board?.title || null,
    owner_name: card.owner?.full_name || null,
    updated: card.updated,
    asap: card.asap || false,
    blocked: !!card.blocked,
  };
}


// ============================================
// RESOURCE TEMPLATES
// ============================================

const resourceTemplates: ResourceTemplate[] = [
  {
    uriTemplate: "kaiten-card:///{cardId}",
    name: "Kaiten Card",
    description: "A Kaiten card with its details, comments, and metadata. Use this to fetch detailed information about a specific card.",
    mimeType: "application/json"
  },
  {
    uriTemplate: "kaiten-space:///{spaceId}",
    name: "Kaiten Space",
    description: "Details about a Kaiten space including its boards and settings.",
    mimeType: "application/json"
  },
  {
    uriTemplate: "kaiten-board:///{boardId}/cards",
    name: "Board Cards",
    description: "All active cards belonging to a specific Kaiten board.",
    mimeType: "application/json"
  },
  {
    uriTemplate: "kaiten-current-user:",
    name: "Current User",
    description: "Information about the authenticated user associated with the API token.",
    mimeType: "application/json"
  }
];

// ============================================
// SERVER PROMPT
// ============================================

const kaitenServerPrompt: Prompt = {
  name: "kaiten-server-prompt",
  description: "Instructions for using the Kaiten MCP server effectively",
  arguments: [],
};

const kaitenServerPromptInstructions = `Kaiten project management MCP server - manage cards, spaces, boards, comments.

CRITICAL Performance Rules:
• kaiten_search_cards: ALWAYS use space_id or board_id filter (omit space_id=default, space_id=0=ALL spaces=SLOW)
• kaiten_list_users: ALWAYS use query parameter (Latin names: "Saranyuk" not "Саранюк")
• Keep limit≤20 when possible to preserve context

Search Strategy:
• Default: searches configured default space with limit=10
• Use query for text search (partial match in title/description/comments)
• CRITICAL Russian search: Use root words for inflected forms (Болгарии/Болгария/болгарский → болгар, валюты/валютный → валют)
• Add board_id to narrow results
• condition: 1=active (default), 2=archived (only when requested)
• Returns compact format - use kaiten_get_card for full details

Card Operations:
• Create: title + board_id required. Find board_id via kaiten_list_boards
• Update: only include fields to change
• Assign: find user via kaiten_list_users(query="name"), use their ID in owner_id
• Comments: support markdown, appear in card history

Users:
• CRITICAL: Kaiten stores LATIN names only
• Search: kaiten_list_users(query="latin_name")
• NEVER call without query - returns ALL users, wastes tokens

Default Space: Most operations auto-use KAITEN_DEFAULT_SPACE_ID unless specified.`;

// ============================================
// TOOLS DEFINITIONS
// ============================================

const tools: Tool[] = [
  {
    name: 'kaiten_get_card',
    description: `Retrieve complete information about a Kaiten card by its ID, including subtasks, blocking status, and relationships.

PURPOSE: Get comprehensive card details after discovering the card via kaiten_search_cards or from a URL. Use this when you need full information including description, owner, board location, blocking reasons, subtasks with progress, parent/child relationships, and comment counts.

PARAMETERS:
- card_id (required): Numeric card ID. Positive integer.
  Examples: 12345, 67890
  How to find: Use kaiten_search_cards, or extract from URL like "https://domain.kaiten.ru/space/123/card/456" where card_id=456
- format (optional): Response format - 'json' or 'markdown' (default)
  • Use 'json' when: Need structured data for programmatic processing, integrations, parsing
  • Use 'markdown' when: Human-readable display with formatting, showing to user - DEFAULT

RETURNS:
- With format='markdown' (default): Human-readable markdown format with:
- With format='json': Full card object as JSON with all fields

Markdown format includes:
- Title, clickable URL, board/column/lane location
- Owner name, members list
- Card type, size estimate, due date
- ASAP flag (⚡) if marked urgent
- BLOCKED status (🚫) with blocking reason, blocker name, and date if applicable
- Tags list
- Comments count and last comment timestamp
- Created/updated timestamps
- Parent/child card relationships section if present:
  - Parent cards count with info message
  - Detailed subtasks list with progress percentage
  - Each subtask shows: state icon (✅ done, 🔄 in progress, ⏳ queued), card ID, title, blocking status, owner, URL
  - Blocking reasons displayed for blocked subtasks
- Full description at the end

USAGE EXAMPLES:
✅ DO: After search to get full details: kaiten_search_cards({query: "payment"}) → kaiten_get_card({card_id: 12345})
✅ DO: Before updating card to see current state: kaiten_get_card({card_id: 12345}) → kaiten_update_card(...)
✅ DO: Extract card_id from Kaiten URLs: "space/123/card/456" → card_id=456
✅ DO: Check subtask progress before marking parent as done
✅ DO: View blocking reasons before unblocking cards
❌ DON'T: Use for bulk operations - use kaiten_search_cards instead for finding multiple cards
❌ DON'T: Repeatedly fetch same card within 5-10 minutes - data doesn't change that frequently
❌ DON'T: Use when you only need card list - use kaiten_get_board_cards or kaiten_search_cards (more efficient)

ERRORS:
- NOT_FOUND (404): Card doesn't exist or was deleted. Verify card_id is correct. Check if card was archived (use kaiten_search_cards with condition=2).
- AUTH_ERROR (403): No permission to view this card. Your API token doesn't have access to this space. Check KAITEN_API_TOKEN has correct permissions.
- TIMEOUT: Rare, occurs with cards having 100+ subtasks. Contact support if persists. Workaround: Use kaiten_search_cards to find child cards separately.

SUBTASKS FEATURE:
- Automatically loads and displays child cards with detailed progress
- Shows completion percentage (e.g., "15/20 done (75%)")
- Displays blocking information for each subtask
- Each subtask includes direct URL for quick access
- State icons: ✅ = done (state 3), 🔄 = in progress (state 2), ⏳ = queued (state 1)

RELATED TOOLS:
- kaiten_search_cards: Find cards before getting details (primary discovery tool)
- kaiten_get_card_comments: Get full comment thread separately if needed
- kaiten_update_card: Modify card after reviewing current state
- kaiten_get_board_cards: List all cards from a board (when you need multiple cards)`,
    annotations: {
      readOnly: true,
      destructive: false,
      idempotent: true,
      openWorld: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        card_id: {
          type: 'number',
          description: 'Card ID',
        },
        format: {
          type: 'string',
          description: 'Response format: json (structured), markdown (default, human-readable)',
        },
      },
      required: ['card_id'],
    },
  },
  {
    name: 'kaiten_create_card',
    description: `Create a new card on a Kaiten board with specified properties. Supports idempotency for safe retries.

PURPOSE: Create new task cards with title, description, owner, due date, and board placement. Use after discovering board structure via kaiten_list_boards, kaiten_list_columns, kaiten_list_lanes, and kaiten_list_types to get valid IDs.

REQUIRED PARAMETERS:
- title (required): Card title, 1-500 characters.
  Examples: "Fix payment gateway bug", "Design new homepage layout"
- board_id (required): Board where card will be created. Positive integer.
  How to find: Use kaiten_list_boards to get board_id from your space

OPTIONAL PARAMETERS:
- column_id (optional): Column (stage) ID. Get from kaiten_list_columns(board_id). If omitted, card goes to first/default column.
- lane_id (optional): Lane (swimlane) ID. Get from kaiten_list_lanes(board_id). If omitted, uses default lane.
- description (optional): Markdown-formatted card description. Can include formatting, lists, links.
- type_id (optional): Card type ID. Get from kaiten_list_types(board_id). Examples: "Task", "Bug", "Feature".
- size (optional): Story points or time estimate. Non-negative number. Examples: 3, 5, 8 (Fibonacci), or hours.
- asap (optional): Mark as urgent/ASAP. Boolean true/false.
- owner_id (optional): Assign to user. Get user_id from kaiten_list_users(query="name").
- due_date (optional): Due date in ISO 8601 format. Example: "2025-11-01T23:59:59Z"
- idempotency_key (optional): Unique key for safe retries. Auto-generated if omitted. Format: UUID or timestamp string.

RETURNS: Full card object as JSON with all fields including:
- id: Newly created card ID
- title, description, board_id, column_id, lane_id
- owner, type, size, asap, due_date
- created, updated timestamps
- URL to access card in Kaiten

USAGE EXAMPLES:
✅ DO: Get board structure first:
  1. kaiten_list_boards() → find board_id
  2. kaiten_list_columns(board_id) → find column_id
  3. kaiten_list_users(query="John") → find owner_id
  4. kaiten_create_card({title: "...", board_id, column_id, owner_id})

✅ DO: Minimal creation: kaiten_create_card({title: "Quick task", board_id: 12345})
✅ DO: Full-featured card:
  {
    title: "Implement user auth",
    board_id: 12345,
    column_id: 67890,
    description: "# Requirements\n- OAuth2\n- JWT tokens",
    type_id: 111,
    size: 8,
    owner_id: 222,
    due_date: "2025-11-15T17:00:00Z",
    asap: true
  }

✅ DO: Use idempotency_key for retry safety if making same request multiple times
❌ DON'T: Create card without checking board exists first - will fail with 404
❌ DON'T: Use invalid column_id/lane_id from different board - causes validation error
❌ DON'T: Assign to non-existent user - verify user_id with kaiten_list_users first
❌ DON'T: Use relative dates like "tomorrow" - must be ISO 8601 format

ERRORS:
- VALIDATION_ERROR (422): Invalid parameters. Common causes:
  - column_id/lane_id/type_id don't exist on this board
  - owner_id doesn't exist or user is deactivated
  - title exceeds 500 characters
  - due_date format invalid (must be ISO 8601)
  Solution: Verify all IDs with kaiten_list_* tools first

- NOT_FOUND (404): board_id doesn't exist or is archived
  Solution: Use kaiten_list_boards to verify board_id

- AUTH_ERROR (403): No permission to create cards in this board
  Solution: Check API token has write access to the space

IDEMPOTENCY:
- Server supports idempotency keys to prevent duplicate cards
- If you retry with same idempotency_key, returns existing card instead of creating duplicate
- Automatically generated if omitted (recommended for most cases)
- Useful when network is unreliable or you're retrying after errors

BOARD STRUCTURE DISCOVERY WORKFLOW:
1. kaiten_list_spaces() - find your space
2. kaiten_list_boards(space_id) - find board_id
3. kaiten_list_columns(board_id) - get column IDs (stages)
4. kaiten_list_lanes(board_id) - get lane IDs (swimlanes)
5. kaiten_list_types(board_id) - get type IDs (Task/Bug/Feature)
6. kaiten_list_users(query="name") - find assignee
7. kaiten_create_card({...all IDs...})

RELATED TOOLS:
- kaiten_list_boards: Find board_id for your space
- kaiten_list_columns: Get valid column_id values
- kaiten_list_lanes: Get valid lane_id values
- kaiten_list_types: Get valid type_id values
- kaiten_list_users: Find owner_id by name
- kaiten_update_card: Modify card after creation if needed`,
    annotations: {
      readOnly: false,
      destructive: false,
      idempotent: true,
      openWorld: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Card title',
        },
        board_id: {
          type: 'number',
          description: 'Board ID',
        },
        column_id: {
          type: 'number',
          description: 'Column ID',
        },
        lane_id: {
          type: 'number',
          description: 'Lane ID',
        },
        description: {
          type: 'string',
          description: 'Card description',
        },
        type_id: {
          type: 'number',
          description: 'Card type ID',
        },
        size: {
          type: 'number',
          description: 'Estimate/size',
        },
        asap: {
          type: 'boolean',
          description: 'Mark as urgent',
        },
        owner_id: {
          type: 'number',
          description: 'Owner user ID',
        },
        due_date: {
          type: 'string',
          description: 'Due date (ISO format)',
        },
      },
      required: ['title', 'board_id'],
    },
  },
  {
    name: 'kaiten_update_card',
    description: `Update existing card fields. Only modifies specified fields, leaving others unchanged. Supports idempotency.

PURPOSE: Modify card properties including title, description, state, board position (column/lane), assignment, dates, and flags. Use kaiten_get_card first to see current state before updating.

REQUIRED PARAMETERS:
- card_id (required): Card ID to update. Positive integer.
  How to find: Use kaiten_search_cards or kaiten_get_card

OPTIONAL PARAMETERS (at least one required):
- title (optional): New card title, 1-500 characters
- description (optional): New markdown description. Pass empty string "" to clear.
- state (optional): Card state. 1=queued, 2=in progress, 3=done
- column_id (optional): Move to column. Get from kaiten_list_columns(board_id).
- lane_id (optional): Move to lane. Get from kaiten_list_lanes(board_id).
- type_id (optional): Change card type. Get from kaiten_list_types(board_id).
- size (optional): Update estimate/story points. Non-negative number.
- asap (optional): Mark/unmark as urgent. Boolean true/false.
- owner_id (optional): Reassign card. Get from kaiten_list_users(query="name"). Pass null to unassign.
- due_date (optional): Set/update due date. ISO 8601 format: "2025-11-01T23:59:59Z". Pass empty string "" to clear.
- idempotency_key (optional): Unique key for safe retries. Auto-generated if omitted.

RETURNS: Updated full card object as JSON with all current field values

USAGE EXAMPLES:
✅ DO: Check current state first:
  1. kaiten_get_card({card_id: 12345}) → review current values
  2. kaiten_update_card({card_id: 12345, state: 3}) → mark as done

✅ DO: Update single field: {card_id: 12345, title: "New title"}
✅ DO: Update multiple fields:
  {
    card_id: 12345,
    state: 2,
    owner_id: 67890,
    due_date: "2025-11-15T23:59:59Z",
    asap: true
  }

✅ DO: Move card to different column:
  1. kaiten_list_columns(board_id) → find new column_id
  2. kaiten_update_card({card_id: 12345, column_id: 99999})

✅ DO: Reassign card:
  1. kaiten_list_users({query: "Maria"}) → get user_id
  2. kaiten_update_card({card_id: 12345, owner_id: <user_id>})

✅ DO: Clear due date: {card_id: 12345, due_date: ""}
✅ DO: Unassign card: {card_id: 12345, owner_id: null}

❌ DON'T: Update without checking current state - may overwrite important changes
❌ DON'T: Move card to column from different board - validation error
❌ DON'T: Set invalid state (not 1, 2, or 3) - validation error
❌ DON'T: Use relative dates - must be ISO 8601 format
❌ DON'T: Forget to verify column_id/lane_id/type_id with kaiten_list_* tools first

PARTIAL UPDATES:
- Only specified fields are modified
- Omitted fields remain unchanged
- Example: {card_id: 12345, title: "New"} only changes title, everything else stays same
- To clear optional fields: use empty string "" (due_date, description) or null (owner_id)

ERRORS:
- NOT_FOUND (404): Card doesn't exist or is deleted
  Solution: Verify card_id with kaiten_search_cards

- VALIDATION_ERROR (422): Invalid parameter values. Common causes:
  - column_id/lane_id/type_id don't belong to card's board
  - owner_id doesn't exist
  - state not 1, 2, or 3
  - title too long (>500 chars)
  - due_date format invalid
  Solution: Verify IDs with kaiten_list_* tools, check format

- AUTH_ERROR (403): No write permission
  Solution: Check API token has edit access to this space

- CONFLICT (409): Card was modified by another user (rare with idempotency)
  Solution: Fetch fresh state with kaiten_get_card, then retry update

IDEMPOTENCY:
- Prevents duplicate updates on network retry
- Same idempotency_key returns same result without re-applying changes
- Auto-generated if omitted (recommended)

STATE MANAGEMENT:
State values represent workflow stages:
- 1 = Queued (backlog, not started)
- 2 = In Progress (active work)
- 3 = Done (completed)

Moving cards through workflow:
1. Create: state defaults to 1 (queued)
2. Start work: update state to 2
3. Complete: update state to 3
Optional: Move between columns to reflect board stages

COMMON WORKFLOWS:

Assign and start work:
  kaiten_update_card({card_id: 12345, owner_id: <user_id>, state: 2})

Mark urgent and set deadline:
  kaiten_update_card({card_id: 12345, asap: true, due_date: "2025-11-01T17:00:00Z"})

Complete card:
  kaiten_update_card({card_id: 12345, state: 3})

Move to different stage:
  kaiten_list_columns(board_id) → find "Code Review" column_id
  kaiten_update_card({card_id: 12345, column_id: <column_id>})

RELATED TOOLS:
- kaiten_get_card: Check current state before updating
- kaiten_list_columns: Find column_id for moves
- kaiten_list_lanes: Find lane_id
- kaiten_list_types: Find type_id
- kaiten_list_users: Find owner_id for reassignment
- kaiten_create_card: Create new cards instead of updating`,
    annotations: {
      readOnly: false,
      destructive: false,
      idempotent: true,
      openWorld: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        card_id: {
          type: 'number',
          description: 'Card ID',
        },
        title: {
          type: 'string',
          description: 'New title',
        },
        description: {
          type: 'string',
          description: 'New description',
        },
        state: {
          type: 'number',
          description: 'New state',
        },
        column_id: {
          type: 'number',
          description: 'Move to column',
        },
        lane_id: {
          type: 'number',
          description: 'Move to lane',
        },
        type_id: {
          type: 'number',
          description: 'New type ID',
        },
        size: {
          type: 'number',
          description: 'New estimate',
        },
        asap: {
          type: 'boolean',
          description: 'Mark as urgent',
        },
        owner_id: {
          type: 'number',
          description: 'New owner ID',
        },
        due_date: {
          type: 'string',
          description: 'New due date (ISO)',
        },
      },
      required: ['card_id'],
    },
  },
  {
    name: 'kaiten_delete_card',
    description: `⚠️ DESTRUCTIVE: Permanently delete a card. Cannot be undone. Use with extreme caution.

PURPOSE: Permanently remove a card from Kaiten. This is an irreversible operation - once deleted, the card and all its data (comments, history, attachments, relationships) are gone forever. Consider archiving (condition=2) as safer alternative.

PARAMETERS:
- card_id (required): Card ID to delete. Positive integer.
  How to find: Use kaiten_search_cards or kaiten_get_card
  ⚠️ VERIFY CAREFULLY: Deleting wrong card cannot be undone!

RETURNS: Empty response on success (HTTP 204 No Content)

⚠️ CRITICAL WARNINGS:
- IRREVERSIBLE: Deleted cards CANNOT be recovered
- ALL DATA LOST: Comments, attachments, history, relationships gone
- BREAKS REFERENCES: Parent/child relationships broken permanently
- NO UNDO: No trash/recycle bin, no recovery mechanism
- TEAM IMPACT: Other team members lose access to card immediately

SAFER ALTERNATIVES:
Instead of deleting, consider:
1. Archive card: kaiten_update_card({card_id, state: 2}) - preserves data
2. Move to "Deleted" board: kaiten_update_card({card_id, board_id: <deleted_board_id>})
3. Mark as cancelled: Add comment "CANCELLED: [reason]" and archive
4. Hide from view: Use Kaiten UI filters to hide specific cards

USAGE EXAMPLES:
✅ DO: Verify card before deletion:
  1. kaiten_get_card({card_id: 12345}) → review card details, check subtasks
  2. Confirm with user: "Delete card #12345 'Title'? This cannot be undone."
  3. kaiten_delete_card({card_id: 12345}) → only after confirmation

✅ DO: Check for dependencies first:
  1. kaiten_get_card({card_id: 12345}) → check children_count, parents_count
  2. If children_count > 0: Warn "Has N subtasks, delete those first?"
  3. Consider archiving instead if card has subtasks

❌ DON'T: Delete without user confirmation - too risky
❌ DON'T: Delete cards with subtasks - breaks parent-child relationships
❌ DON'T: Use for "cleanup" - archive instead (safer, reversible)
❌ DON'T: Delete cards with active discussions (comments_total > 0) without review
❌ DON'T: Batch delete multiple cards without individual verification

WHEN TO USE DELETE vs ARCHIVE:
**Use DELETE only for:**
- Spam cards created by mistake
- Test/demo cards in non-production environments
- Duplicate cards with no meaningful data
- Cards created seconds ago with no activity

**Use ARCHIVE (preferred) for:**
- Completed work (preserves history)
- Cancelled projects (keeps documentation)
- Old cards with discussions (maintains context)
- Anything you might reference later

ERRORS:
- NOT_FOUND (404): Card doesn't exist or already deleted
  Solution: Verify card_id with kaiten_search_cards

- AUTH_ERROR (403): No permission to delete cards
  Solution: Check API token has delete permissions in this space

- CONFLICT (409): Card has dependencies preventing deletion (rare)
  Solution: Remove blocking relationships first, or archive instead

DELETION WORKFLOW:
Safe deletion procedure:

1. **Verify card exists:**
   kaiten_get_card({card_id: 12345}) → confirm correct card

2. **Check for dependencies:**
   - children_count > 0? → Has subtasks
   - comments_total > 0? → Has discussion
   - Blocked/blocking other cards? → Active relationships

3. **Get user confirmation:**
   Show card details and ask: "Delete this card? Cannot be undone."

4. **Consider alternatives:**
   Suggest archive if card has data worth preserving

5. **Delete if confirmed:**
   kaiten_delete_card({card_id: 12345})

6. **Confirm success:**
   Notify user: "Card #12345 deleted permanently"

ARCHIVING AS ALTERNATIVE:
Archive preserves all data but hides card from active view:
\`\`\`javascript
// Archive instead of delete
kaiten_update_card({
  card_id: 12345,
  state: 3,  // Mark as done
  // Then search with condition=2 to find archived cards
})
\`\`\`

Search archived cards later:
\`\`\`javascript
kaiten_search_cards({
  board_id: 12345,
  condition: 2  // condition=2 means archived
})
\`\`\`

RELATED TOOLS:
- kaiten_get_card: Verify card details before deletion
- kaiten_update_card: Archive card instead (safer alternative)
- kaiten_search_cards: Find cards before deletion, verify correct card_id`,
    annotations: {
      readOnly: false,
      destructive: true,
      idempotent: true,
      openWorld: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        card_id: {
          type: 'number',
          description: 'Card ID',
        },
      },
      required: ['card_id'],
    },
  },
  {
    name: 'kaiten_get_card_comments',
    description: `Get all comments for a card, including author info and timestamps. Returns complete comment thread.

PURPOSE: Retrieve full comment history and discussion thread for a card. Use to review feedback, track decisions, or analyze communication. Comments appear in Kaiten card history and support markdown formatting.

PARAMETERS:
- card_id (required): Card ID to get comments from. Positive integer.
  How to find: Use kaiten_search_cards or kaiten_get_card

RETURNS: Simplified JSON array of comment objects, ordered chronologically:
- id: Comment ID (use for update/delete operations)
- text: Comment content (supports markdown)
- created: Comment creation timestamp (ISO 8601)
- updated: Last update timestamp if edited (ISO 8601)
- author_id: User ID of comment author
- author_name: Full name of author

Empty array [] if card has no comments.

USAGE EXAMPLES:
✅ DO: Review discussion before taking action:
  1. kaiten_search_cards({query: "bug report"}) → find card
  2. kaiten_get_card_comments({card_id: 12345}) → read discussion
  3. Take informed action based on comments

✅ DO: Check latest feedback: Sort by created timestamp, read most recent
✅ DO: Find specific comment to update/delete: Match by text or author
✅ DO: Analyze card communication patterns: Count comments, check authors

❌ DON'T: Poll repeatedly for new comments - not a real-time API, use webhooks if available
❌ DON'T: Expect comments to include card changes - only user comments, not system events
❌ DON'T: Assume chronological display - client may reorder, use created timestamp

ERRORS:
- NOT_FOUND (404): Card doesn't exist or was deleted
  Solution: Verify card_id with kaiten_search_cards

- AUTH_ERROR (403): No permission to view card/comments
  Solution: Check API token has read access to the card's space

COMMENT CONTENT:
- Supports markdown formatting: **bold**, *italic*, links, lists
- Can include mentions (@username), though API returns plain text
- May contain code blocks, images (as markdown), links
- Text length typically under 5000 characters per comment
- Rendered markdown display only in Kaiten UI, API returns raw markdown

PERFORMANCE:
- Not cached - fetches fresh data on every call
- Typical response: 1-50 comments per card (under 20KB)
- Large threads (100+ comments) may take 1-2 seconds
- No pagination - returns all comments at once

COMMON WORKFLOWS:

Read discussion before replying:
  kaiten_get_card_comments({card_id: 12345}) → review thread
  kaiten_create_comment({card_id: 12345, text: "..."}) → add reply

Find comment to update:
  kaiten_get_card_comments({card_id: 12345}) → find comment by text/author
  kaiten_update_comment({card_id: 12345, comment_id: 789, text: "..."})

Analyze communication:
  kaiten_get_card_comments({card_id: 12345}) → count comments
  Group by author_name → identify most active participants

COMMENT vs CARD INFO:
- kaiten_get_card shows comments_total count + last_comment_date
- kaiten_get_card_comments shows full comment text + authors
- Use kaiten_get_card first to check if comments exist (comments_total > 0)
- Fetch full thread only when needed to save API calls

RELATED TOOLS:
- kaiten_get_card: Check comments_total before fetching full thread
- kaiten_create_comment: Add new comment to card
- kaiten_update_comment: Edit existing comment
- kaiten_delete_comment: Remove comment
- kaiten_search_cards: Find cards before getting comments`,
    annotations: {
      readOnly: true,
      destructive: false,
      idempotent: true,
      openWorld: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        card_id: {
          type: 'number',
          description: 'Card ID',
        },
      },
      required: ['card_id'],
    },
  },
  {
    name: 'kaiten_create_comment',
    description: `Add a new comment to a card. Supports markdown formatting and appears in card activity history. Supports idempotency.

PURPOSE: Post feedback, ask questions, provide updates, or document decisions on a card. Comments are visible to all card participants and appear in Kaiten card history chronologically. Essential for team communication and documentation.

REQUIRED PARAMETERS:
- card_id (required): Card to add comment to. Positive integer.
  How to find: Use kaiten_search_cards or kaiten_get_card
- text (required): Comment content. Supports markdown formatting. Minimum 1 character.
  Examples: "Looks good!", "# Next Steps\n- Test on staging\n- Deploy Friday"

OPTIONAL PARAMETERS:
- idempotency_key (optional): Unique key for safe retries. Auto-generated if omitted.
  Format: UUID or timestamp string

RETURNS: Full comment object as JSON with:
- id: New comment ID (use for update/delete)
- text: Comment content as posted
- created: Creation timestamp
- updated: Initially same as created
- author_id: Your user ID (from API token)
- author_name: Your full name
- card_id: Parent card ID

USAGE EXAMPLES:
✅ DO: Simple text comment:
  kaiten_create_comment({
    card_id: 12345,
    text: "Completed testing, ready for deploy"
  })

✅ DO: Markdown formatted comment:
  kaiten_create_comment({
    card_id: 12345,
    text: "# Testing Results\\n**Status**: All tests passed ✅\\n**Issues found**: None\\n**Next step**: Deploy to production"
  })

✅ DO: Multi-line comment with code:
  kaiten_create_comment({
    card_id: 12345,
    text: "Fixed the bug:\\n\\n\\\`\\\`\\\`js\\nif (user) {\\n  return user.name;\\n}\\n\\\`\\\`\\\`"
  })

✅ DO: Link to external resources:
  kaiten_create_comment({
    card_id: 12345,
    text: "PR merged: https://github.com/repo/pull/123"
  })

❌ DON'T: Post empty or whitespace-only comments - validation error
❌ DON'T: Include sensitive data (passwords, tokens) - comments are visible to all
❌ DON'T: Use for status updates - update card fields instead (state, owner_id, etc.)
❌ DON'T: Spam with duplicate comments - check existing thread first with kaiten_get_card_comments

ERRORS:
- NOT_FOUND (404): Card doesn't exist or was deleted
  Solution: Verify card_id with kaiten_search_cards

- VALIDATION_ERROR (422): Invalid text parameter
  Common causes:
  - Empty text or whitespace only
  - Text exceeds max length (typically 10000 characters)
  Solution: Provide meaningful comment text, check length

- AUTH_ERROR (403): No permission to comment on card
  Solution: Check API token has write access to card's space

IDEMPOTENCY:
- Prevents duplicate comments on network retry
- Same idempotency_key returns existing comment instead of creating duplicate
- Auto-generated if omitted (recommended for most cases)
- Useful when network is unreliable or you're retrying after errors
- Key format: UUID or timestamp-based string (e.g., "comment-2025-10-22-12345")

MARKDOWN SUPPORT:
Comments support full markdown syntax:
- **Bold text**, *italic text*, ~~strikethrough~~
- [Links](https://example.com)
- # Headers (H1-H6)
- - Bulleted lists
- 1. Numbered lists
- \`inline code\`, \`\`\`code blocks\`\`\`
- > Blockquotes
- Tables (limited support)
- Mentions (@username) - appear as plain text in API, clickable in UI

COMMENT VISIBILITY:
- Appears immediately in card activity history
- Visible to all users with card access
- Triggers notifications to card followers (if enabled in Kaiten)
- Cannot be made private or hidden
- Searchable via card query parameter in kaiten_search_cards

COMMON WORKFLOWS:

Add status update:
  kaiten_create_comment({
    card_id: 12345,
    text: "Status: Development complete, moved to Testing"
  })

Document decision:
  kaiten_create_comment({
    card_id: 12345,
    text: "Decision: Using PostgreSQL instead of MySQL based on team vote (5-2)"
  })

Request feedback:
  kaiten_create_comment({
    card_id: 12345,
    text: "@TeamLead Please review when ready. Priority: High"
  })

Link external resources:
  kaiten_create_comment({
    card_id: 12345,
    text: "Design mockups: https://figma.com/file/..."
  })

RELATED TOOLS:
- kaiten_get_card_comments: View existing comments before adding
- kaiten_update_comment: Edit your comment if needed
- kaiten_delete_comment: Remove comment if posted by mistake
- kaiten_get_card: Check comments_total to see discussion activity
- kaiten_search_cards: Find cards before commenting`,
    annotations: {
      readOnly: false,
      destructive: false,
      idempotent: true,
      openWorld: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        card_id: {
          type: 'number',
          description: 'Card ID',
        },
        text: {
          type: 'string',
          description: 'Comment text',
        },
      },
      required: ['card_id', 'text'],
    },
  },
  {
    name: 'kaiten_update_comment',
    description: `Edit an existing comment on a card. Supports markdown. Can only edit your own comments. Supports idempotency.

PURPOSE: Fix typos, add information, or clarify existing comments. Preserves comment ID and creation date, updates modified timestamp. Essential for maintaining accurate discussion threads. Supports full markdown formatting.

REQUIRED PARAMETERS:
- card_id (required): Card containing the comment. Positive integer.
  How to find: Use kaiten_search_cards or kaiten_get_card
- comment_id (required): Comment ID to update. Positive integer.
  How to find: Use kaiten_get_card_comments to get comment IDs
- text (required): New comment content. Minimum 1 character. Supports markdown.
  Note: Completely replaces old text (not append/prepend)

OPTIONAL PARAMETERS:
- idempotency_key (optional): Unique key for safe retries. Auto-generated if omitted.

RETURNS: Updated comment object as JSON with:
- id: Comment ID (unchanged)
- text: New comment content
- created: Original creation timestamp (unchanged)
- updated: New update timestamp
- author_id: Author ID (unchanged)
- author_name: Author name (unchanged)
- card_id: Parent card ID (unchanged)

USAGE EXAMPLES:
✅ DO: Fix typo in your comment:
  1. kaiten_get_card_comments({card_id: 12345}) → find comment_id
  2. kaiten_update_comment({
       card_id: 12345,
       comment_id: 789,
       text: "Fixed typo: complEted testing"
     })

✅ DO: Add information to existing comment:
  1. Get current comment text from kaiten_get_card_comments
  2. Append new info: original_text + "\\n\\nUpdate: Also tested on Firefox"
  3. kaiten_update_comment with combined text

✅ DO: Improve formatting:
  kaiten_update_comment({
    card_id: 12345,
    comment_id: 789,
    text: "# Test Results\\n**Passed**: 10\\n**Failed**: 0"
  })

❌ DON'T: Try to edit other users' comments - will fail with 403
❌ DON'T: Update with empty text - validation error
❌ DON'T: Forget this replaces entire text - not incremental update
❌ DON'T: Update comments to remove important information without team agreement

PERMISSIONS:
- Can ONLY edit your own comments (author_id matches your user_id)
- Cannot edit comments by other team members
- Admin/owner permissions don't override this restriction
- Attempting to edit others' comments returns AUTH_ERROR (403)

WHO CAN EDIT:
- Your comments only: kaiten_get_current_user() → get your user_id
- Check comment author: kaiten_get_card_comments() → compare author_id
- If author_id != your user_id: Cannot edit, will get 403 error

ERRORS:
- NOT_FOUND (404): Card or comment doesn't exist
  Solution: Verify card_id and comment_id with kaiten_get_card_comments

- AUTH_ERROR (403): Not your comment or no edit permissions
  Common cause: Trying to edit someone else's comment
  Solution: Only edit comments where author_id matches your user_id

- VALIDATION_ERROR (422): Invalid text parameter
  Common causes:
  - Empty text or whitespace only
  - Text exceeds max length (typically 10000 characters)
  Solution: Provide meaningful text, check length

IDEMPOTENCY:
- Prevents duplicate updates on network retry
- Same idempotency_key with same text returns success without re-applying
- Auto-generated if omitted (recommended)
- Format: UUID or timestamp-based string

TEXT REPLACEMENT BEHAVIOR:
- REPLACES entire comment text (not partial update)
- To append: Fetch current text first, then update with old + new
- To prepend: Fetch current text first, then update with new + old
- Cannot delete comment via empty text - use kaiten_delete_comment instead

MARKDOWN SUPPORT:
Full markdown syntax supported (same as kaiten_create_comment):
- **Bold**, *italic*, ~~strikethrough~~
- [Links](https://example.com)
- # Headers, lists, code blocks
- @mentions (appear as plain text in API)

EDIT HISTORY:
- Updated timestamp changes to current time
- Original created timestamp preserved
- Kaiten UI shows "edited" indicator
- No version history - only current text visible
- Consider adding "EDIT: [reason]" at end for transparency

COMMON WORKFLOWS:

Fix typo:
  1. kaiten_get_card_comments({card_id: 12345})
  2. Find your comment by author_id
  3. kaiten_update_comment({card_id, comment_id, text: "corrected text"})

Add update to existing comment:
  1. kaiten_get_card_comments({card_id: 12345}) → get current text
  2. Combine: current_text + "\\n\\nEDIT: Additional info here"
  3. kaiten_update_comment({card_id, comment_id, text: combined})

Improve clarity:
  1. Review comment in kaiten_get_card_comments
  2. Rewrite for better clarity
  3. kaiten_update_comment with improved text
  4. Optional: Add "EDIT: Clarified for better understanding"

ALTERNATIVE: DELETE AND RECREATE:
If you want to completely replace comment (new creation timestamp):
  1. kaiten_delete_comment({card_id, comment_id})
  2. kaiten_create_comment({card_id, text: "new text"})
Note: Loses comment_id, appears as new comment in thread

RELATED TOOLS:
- kaiten_get_card_comments: Find comment_id and current text before updating
- kaiten_create_comment: Add new comment instead of editing
- kaiten_delete_comment: Remove comment entirely if needed
- kaiten_get_current_user: Verify your user_id to check if you can edit`,
    annotations: {
      readOnly: false,
      destructive: false,
      idempotent: true,
      openWorld: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        card_id: {
          type: 'number',
          description: 'Card ID',
        },
        comment_id: {
          type: 'number',
          description: 'Comment ID',
        },
        text: {
          type: 'string',
          description: 'New text',
        },
      },
      required: ['card_id', 'comment_id', 'text'],
    },
  },
  {
    name: 'kaiten_delete_comment',
    description: 'Delete comment',
    annotations: {
      readOnly: false,
      destructive: true,
      idempotent: true,
      openWorld: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        card_id: {
          type: 'number',
          description: 'Card ID',
        },
        comment_id: {
          type: 'number',
          description: 'Comment ID',
        },
      },
      required: ['card_id', 'comment_id'],
    },
  },
  {
    name: 'kaiten_search_cards',
    description: `Search for Kaiten cards with flexible filtering and pagination. Returns compact format optimized for context economy.

PURPOSE: Find cards matching specific criteria across boards and spaces. Use this as your primary discovery tool before performing operations on cards. Searches default space by default with limit of 10 cards, sorted by newest first.

PARAMETERS:
- query (optional): Text search across card titles, descriptions, and comments. Supports partial matching. For Russian text, use root words for inflected forms (e.g., "валют" matches "валюты", "валютный").
- space_id (optional): Filter by space. Omit to use default space from KAITEN_DEFAULT_SPACE_ID. Set to 0 to search ALL spaces (slower, use sparingly).
- board_id (optional, RECOMMENDED): Filter by board ID. Highly recommended to avoid large result sets and timeouts.
- column_id, lane_id, state, type_id (optional): Filter by board position or card type.
- condition (optional): 1=active (default), 2=archived. Only set to 2 when explicitly searching archived cards.
- Date filters: created_before/after, updated_before/after, due_date_before/after in ISO 8601 format (e.g., "2025-10-22T00:00:00Z")
- Boolean flags: asap (urgent cards), overdue, done_on_time, archived, with_due_date
- Multiple IDs: owner_ids, member_ids, column_ids, type_ids, tag_ids as comma-separated strings (e.g., "123,456,789")
- Exclude filters: exclude_board_ids, exclude_owner_ids, exclude_card_ids
- sort_by (optional): "created" (default), "updated", "title"
- sort_direction (optional): "desc" (default), "asc"
- limit (optional): Max cards to return. Default: 10, max: 20 for context economy
- skip (optional): Skip N cards for pagination. Default: 0
- verbosity (optional): Response detail level - 'minimal', 'normal' (default), 'detailed'
  • Use 'minimal' when: Listing many cards (>10), need just IDs/titles, preserving context budget
  • Use 'normal' when: Standard search, need essential info (owner, board, status) - DEFAULT
  • Use 'detailed' when: Debugging, need full API response with all metadata

RETURNS: Human-readable markdown summary with compact card info (verbosity-controlled):
- id, title, URL
- board_title, owner_name
- updated timestamp
- ASAP and BLOCKED flags
Each card is numbered for easy reference. Ends with instruction to use kaiten_get_card for full details.

USAGE EXAMPLES:
✅ DO: Search within a specific board: {board_id: 12345, query: "payment"}
✅ DO: Find ASAP cards: {board_id: 12345, asap: true, limit: 20}
✅ DO: Find cards by owner: {board_id: 12345, owner_id: 67890}
✅ DO: Use root words for Russian search: {query: "болгар"} matches "Болгарии", "болгарский"
✅ DO: Keep limit ≤ 20 to preserve context budget
❌ DON'T: Search all spaces without filters (space_id: 0, no board_id) - causes timeouts
❌ DON'T: Use large limits (>20) without space_id or board_id - wastes context
❌ DON'T: Use exact inflected forms for Russian (query: "валюты") - may miss "валют", "валютный"
❌ DON'T: Forget to set condition=2 when searching for archived cards

ERRORS:
- TIMEOUT: Query too broad (no space_id/board_id filter). Solution: Add board_id or reduce scope.
- NO_RESULTS: No matches found. Try broader query (root words), check filters, verify space_id is correct.
- VALIDATION_ERROR: Invalid parameter format. Check date formats are ISO 8601, IDs are positive integers.

PERFORMANCE TIPS:
- ALWAYS include board_id when possible (60-80% faster)
- For user search, use kaiten_list_users(query="name") to get user_id first, then search by owner_id
- Keep limit ≤ 20 unless pagination is essential
- Default space search (omit space_id) is fastest

RELATED TOOLS:
- kaiten_get_card: Get full details for a specific card after finding it
- kaiten_get_board_cards: Get all cards from a board without filters (faster for small boards)
- kaiten_list_users: Find user_id before filtering by owner_id
- kaiten_list_boards: Discover board_id for your space`,
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Text search (title/description/comments)',
        },
        title: {
          type: 'string',
          description: 'Exact title match',
        },
        space_id: {
          type: 'number',
          description: 'Space ID (omit=default, 0=ALL spaces)',
        },
        board_id: {
          type: 'number',
          description: 'Board ID (recommended)',
        },
        column_id: {
          type: 'number',
          description: 'Column ID',
        },
        lane_id: {
          type: 'number',
          description: 'Lane ID',
        },
        state: {
          type: 'number',
          description: 'State: 1=queued, 2=inProgress, 3=done',
        },
        owner_id: {
          type: 'number',
          description: 'Owner ID',
        },
        type_id: {
          type: 'number',
          description: 'Card type ID',
        },
        condition: {
          type: 'number',
          description: '1=active (default), 2=archived',
        },
        created_before: {
          type: 'string',
          description: 'Created before (ISO 8601)',
        },
        created_after: {
          type: 'string',
          description: 'Created after (ISO 8601)',
        },
        updated_before: {
          type: 'string',
          description: 'Updated before (ISO 8601)',
        },
        updated_after: {
          type: 'string',
          description: 'Updated after (ISO 8601)',
        },
        due_date_before: {
          type: 'string',
          description: 'Due before (ISO 8601)',
        },
        due_date_after: {
          type: 'string',
          description: 'Due after (ISO 8601)',
        },
        last_moved_to_done_at_before: {
          type: 'string',
          description: 'Completed before (ISO 8601)',
        },
        last_moved_to_done_at_after: {
          type: 'string',
          description: 'Completed after (ISO 8601)',
        },
        asap: {
          type: 'boolean',
          description: 'Only ASAP cards',
        },
        archived: {
          type: 'boolean',
          description: 'Only archived',
        },
        overdue: {
          type: 'boolean',
          description: 'Only overdue',
        },
        done_on_time: {
          type: 'boolean',
          description: 'Done on time',
        },
        with_due_date: {
          type: 'boolean',
          description: 'Has due date',
        },
        owner_ids: {
          type: 'string',
          description: 'Owner IDs (comma-separated)',
        },
        member_ids: {
          type: 'string',
          description: 'Member IDs (comma-separated)',
        },
        column_ids: {
          type: 'string',
          description: 'Column IDs (comma-separated)',
        },
        type_ids: {
          type: 'string',
          description: 'Type IDs (comma-separated)',
        },
        tag_ids: {
          type: 'string',
          description: 'Tag IDs (comma-separated)',
        },
        exclude_board_ids: {
          type: 'string',
          description: 'Exclude boards (comma-separated)',
        },
        exclude_owner_ids: {
          type: 'string',
          description: 'Exclude owners (comma-separated)',
        },
        exclude_card_ids: {
          type: 'string',
          description: 'Exclude cards (comma-separated)',
        },
        sort_by: {
          type: 'string',
          description: 'Sort: created/updated/title',
        },
        sort_direction: {
          type: 'string',
          description: 'Direction: asc/desc',
        },
        limit: {
          type: 'number',
          description: 'Max cards (default 10, max 20)',
        },
        skip: {
          type: 'number',
          description: 'Skip for pagination',
        },
        verbosity: {
          type: 'string',
          description: 'Detail level: minimal (ID+title), normal (default, essential), detailed (full)',
        },
      },
    },
  },
  {
    name: 'kaiten_get_space_cards',
    description: `Get all cards from a specific space with pagination. Returns compact format optimized for context economy.

PURPOSE: Retrieve cards from a space when you need all/recent cards without complex filtering. For filtered search, use kaiten_search_cards instead.

PARAMETERS:
- space_id (required): The space ID to get cards from
- limit (optional): Max cards. Default: 10, max: 20
- skip (optional): Skip N cards for pagination
- condition (optional): 1=active (default), 2=archived
- verbosity (optional): 'minimal' (ID+title), 'normal' (default, essential info), 'detailed' (full API response)

VERBOSITY GUIDANCE:
• Use 'minimal' when: Quick list of 15-20 cards, just need IDs to reference, preserving context
• Use 'normal' when: Standard retrieval, need owner/board/status info - DEFAULT
• Use 'detailed' when: Need all metadata, debugging, or analyzing card properties

RETURNS: Human-readable markdown with card info (verbosity-controlled)

USAGE EXAMPLES:
✅ kaiten_get_space_cards({space_id: 123, limit: 15, verbosity: 'minimal'})
✅ kaiten_get_space_cards({space_id: 123}) // normal verbosity by default`,
    inputSchema: {
      type: 'object',
      properties: {
        space_id: {
          type: 'number',
          description: 'Space ID',
        },
        limit: {
          type: 'number',
          description: 'Max cards (default 10, max 20)',
        },
        skip: {
          type: 'number',
          description: 'Skip for pagination',
        },
        condition: {
          type: 'number',
          description: '1=active (default), 2=archived',
        },
        verbosity: {
          type: 'string',
          description: 'Detail level: minimal (ID+title), normal (default), detailed (full)',
        },
      },
      required: ['space_id'],
    },
  },
  {
    name: 'kaiten_get_board_cards',
    description: `Get all cards from a specific board with pagination. Returns compact format optimized for context economy.

PURPOSE: Retrieve cards from a board when you need all/recent cards without complex filtering. For filtered search, use kaiten_search_cards instead.

PARAMETERS:
- board_id (required): The board ID to get cards from
- limit (optional): Max cards. Default: 10, max: 20
- skip (optional): Skip N cards for pagination
- condition (optional): 1=active (default), 2=archived
- verbosity (optional): 'minimal' (ID+title), 'normal' (default, essential info), 'detailed' (full API response)

VERBOSITY GUIDANCE:
• Use 'minimal' when: Quick list of 15-20 cards, just need IDs, saving context tokens
• Use 'normal' when: Standard retrieval, need owner/status info - DEFAULT
• Use 'detailed' when: Need all metadata for analysis or debugging

RETURNS: Human-readable markdown with card info (verbosity-controlled)

USAGE EXAMPLES:
✅ kaiten_get_board_cards({board_id: 456, limit: 20, verbosity: 'minimal'})
✅ kaiten_get_board_cards({board_id: 456}) // normal verbosity by default`,
    inputSchema: {
      type: 'object',
      properties: {
        board_id: {
          type: 'number',
          description: 'Board ID',
        },
        limit: {
          type: 'number',
          description: 'Max cards (default 10, max 20)',
        },
        skip: {
          type: 'number',
          description: 'Skip for pagination',
        },
        condition: {
          type: 'number',
          description: '1=active (default), 2=archived',
        },
        verbosity: {
          type: 'string',
          description: 'Detail level: minimal (ID+title), normal (default), detailed (full)',
        },
      },
      required: ['board_id'],
    },
  },
  {
    name: 'kaiten_list_spaces',
    description: `List all Kaiten spaces (workspaces) accessible to your API token. Top-level organization structure.

PURPOSE: Discover available spaces to get space_id for board operations. Spaces are top-level containers that group boards, users, and projects. Use this for workspace discovery, especially when KAITEN_DEFAULT_SPACE_ID is not set or working with multiple spaces.

PARAMETERS: None

RETURNS: Simplified JSON array of space objects:
- id: Space ID (use for space_id in other operations)
- title: Space name/title
- description: Space description (if set)
- archived: Boolean, true if space is archived
- boards: Array of board objects in this space (basic info only)

Cached for 300 seconds (5 minutes) for performance. Use kaiten_cache_invalidate_spaces to force refresh.

USAGE EXAMPLES:
✅ DO: Discover spaces on first run:
  kaiten_list_spaces() → find your workspace space_id

✅ DO: Verify KAITEN_DEFAULT_SPACE_ID is correct:
  kaiten_list_spaces() → check if default space_id exists in list

✅ DO: Multi-workspace operations:
  1. kaiten_list_spaces() → get all space_ids
  2. Loop: kaiten_list_boards(space_id) for each space

✅ DO: Find space by name:
  kaiten_list_spaces() → filter by title to find space_id

❌ DON'T: Call repeatedly within 5 minutes - results are cached
❌ DON'T: Expect detailed board data - use kaiten_list_boards(space_id) for full board info
❌ DON'T: Assume single space - organizations may have multiple spaces

ERRORS:
- AUTH_ERROR (403): API token lacks permission to list spaces
  Solution: Check token has read access, verify in Kaiten admin settings

- Empty array []: No spaces accessible or all archived
  Solution: Verify API token is valid, check space permissions in Kaiten

SPACE HIERARCHY:
Kaiten organization structure:
1. **Organization** (top level, not in API)
2. **Spaces** (workspaces) ← this tool lists these
3. **Boards** (projects/teams) ← use kaiten_list_boards
4. **Cards** (tasks) ← use kaiten_search_cards

SPACES vs BOARDS:
- **Space**: High-level workspace container, groups boards by department/project
- **Board**: Kanban board within space, contains cards
- Example structure:
  - Space: "Engineering Department"
    - Board: "Backend Team"
    - Board: "Frontend Team"
  - Space: "Marketing"
    - Board: "Content Calendar"
    - Board: "Campaign Tracker"

CACHING:
- Spaces list cached for 300 seconds (5 min) after first fetch
- Reduces API calls, improves performance
- Auto-expires after TTL
- Force refresh: kaiten_cache_invalidate_spaces
- Cache shared across operations (list_spaces, get_space)

DEFAULT SPACE BEHAVIOR:
- If KAITEN_DEFAULT_SPACE_ID set: Most operations default to that space
- If not set: Must provide space_id explicitly
- Recommendation: Set default space if working primarily in one space
- Override default: Pass space_id=0 to kaiten_search_cards for all spaces

COMMON WORKFLOWS:

Initial setup:
  kaiten_list_spaces() → find your space_id
  → Set KAITEN_DEFAULT_SPACE_ID in .env
  → Restart server

Discover workspace structure:
  1. kaiten_list_spaces() → list all spaces
  2. For each space: kaiten_list_boards(space_id) → get boards
  3. For each board: kaiten_list_columns(board_id) → get structure

Multi-workspace search:
  1. kaiten_list_spaces() → get all space_ids
  2. Loop through spaces:
     kaiten_search_cards({space_id, query: "bug"})
  3. Aggregate results from all spaces

RELATED TOOLS:
- kaiten_get_space: Get detailed space info including full board list
- kaiten_list_boards: List boards within a space (next step after list_spaces)
- kaiten_search_cards: Set space_id=0 to search all spaces
- kaiten_cache_invalidate_spaces: Force refresh cached spaces`,
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'kaiten_get_space',
    description: `Get space details by ID.

PURPOSE: Retrieve comprehensive information about a specific Kaiten space.

PARAMETERS:
- space_id (required): Space ID. Positive integer.
  How to find: Use kaiten_list_spaces to discover space_id
- format (optional): Response format - 'json' or 'markdown' (default)
  • Use 'json' when: Need structured data for programmatic processing, integrations, parsing
  • Use 'markdown' when: Human-readable display with formatting, showing to user - DEFAULT

RETURNS:
- With format='markdown' (default): Human-readable markdown format with space details
- With format='json': Full space object as JSON with all fields`,
    inputSchema: {
      type: 'object',
      properties: {
        space_id: {
          type: 'number',
          description: 'Space ID',
        },
        format: {
          type: 'string',
          description: 'Response format: json (structured), markdown (default, human-readable)',
        },
      },
      required: ['space_id'],
    },
  },
  {
    name: 'kaiten_list_boards',
    description: `List all boards in a space. Essential discovery tool for finding board_id before card operations.

PURPOSE: Discover available boards in your workspace to get board_id for creating/searching cards. First step in board structure discovery workflow. Uses cached results (5 min TTL) for performance.

PARAMETERS:
- space_id (optional): Space ID to filter boards. If omitted, uses KAITEN_DEFAULT_SPACE_ID from environment.
  How to find: Use kaiten_list_spaces to discover space_id
- verbosity (optional): Response detail level - 'minimal', 'normal' (default), 'detailed'
  • Use 'minimal' when: Quick list, just need ID+title for reference
  • Use 'normal' when: Standard list with space_id, archived status - DEFAULT
  • Use 'detailed' when: Need all board metadata from API

RETURNS: JSON array of board objects (verbosity-controlled) with:
- id: Board ID (use for board_id in card operations)
- title: Board name/title
- space_id: Parent space ID
- archived: Boolean indicating if board is archived

Cached for 300 seconds (5 minutes) for performance. Use kaiten_cache_invalidate_boards if need fresh data.

USAGE EXAMPLES:
✅ DO: List boards in default space: kaiten_list_boards() (no params)
✅ DO: List boards in specific space: kaiten_list_boards({space_id: 12345})
✅ DO: Use this before creating cards to find correct board_id
✅ DO: Discovery workflow:
  1. kaiten_list_boards() → find board_id
  2. kaiten_list_columns(board_id) → get columns
  3. kaiten_create_card({board_id, ...})

❌ DON'T: Hardcode board_id - boards can be renamed/archived, always discover first
❌ DON'T: Skip this step before create_card - will cause 404 errors
❌ DON'T: Call repeatedly within 5 minutes - results are cached

ERRORS:
- NOT_FOUND (404): space_id doesn't exist or is archived
  Solution: Verify space_id with kaiten_list_spaces

- AUTH_ERROR (403): No permission to view boards in this space
  Solution: Check API token has read access to the space

- MISSING_SPACE_ID: No space_id provided and KAITEN_DEFAULT_SPACE_ID not set
  Solution: Set KAITEN_DEFAULT_SPACE_ID in .env or pass space_id parameter

CACHING:
- Boards list is cached for 300 seconds (5 min) after first fetch
- Reduces API calls and improves performance
- Cache auto-expires, or force refresh with kaiten_cache_invalidate_boards
- Cache shared across all operations (list_boards, get_board, etc.)

BOARD STRUCTURE DISCOVERY WORKFLOW:
This is typically the first step in working with cards:

1. **Find boards**: kaiten_list_boards() → get board_id
2. **Explore board**: kaiten_list_columns(board_id) → get stages
3. **Optional**: kaiten_list_lanes(board_id) → get swimlanes
4. **Optional**: kaiten_list_types(board_id) → get card types
5. **Create/search cards**: Use discovered board_id

RELATED TOOLS:
- kaiten_list_spaces: Find space_id if not using default space
- kaiten_get_board: Get detailed board info including settings
- kaiten_list_columns: Get board columns (stages) for card placement
- kaiten_list_lanes: Get board lanes (swimlanes)
- kaiten_list_types: Get card types available on board
- kaiten_search_cards: Search cards on specific board
- kaiten_cache_invalidate_boards: Force refresh cached boards`,
    inputSchema: {
      type: 'object',
      properties: {
        space_id: {
          type: 'number',
          description: 'Space ID filter',
        },
        verbosity: {
          type: 'string',
          description: 'Detail level: minimal (ID+title), normal (default, space_id/archived), detailed (full)',
        },
      },
    },
  },
  {
    name: 'kaiten_get_board',
    description: `Get board details by ID.

PURPOSE: Retrieve comprehensive information about a specific Kaiten board.

PARAMETERS:
- board_id (required): Board ID. Positive integer.
  How to find: Use kaiten_list_boards to discover board_id
- format (optional): Response format - 'json' or 'markdown' (default)
  • Use 'json' when: Need structured data for programmatic processing, integrations, parsing
  • Use 'markdown' when: Human-readable display with formatting, showing to user - DEFAULT

RETURNS:
- With format='markdown' (default): Human-readable markdown format with board details
- With format='json': Full board object as JSON with all fields`,
    inputSchema: {
      type: 'object',
      properties: {
        board_id: {
          type: 'number',
          description: 'Board ID',
        },
        format: {
          type: 'string',
          description: 'Response format: json (structured), markdown (default, human-readable)',
        },
      },
      required: ['board_id'],
    },
  },
  {
    name: 'kaiten_list_columns',
    description: `List all columns (workflow stages) for a board. Required before creating/moving cards to get valid column_id.

PURPOSE: Discover board columns (stages like "Backlog", "In Progress", "Done") to place cards correctly. Columns represent workflow stages and are required for precise card placement. Use before kaiten_create_card or kaiten_update_card with column_id.

PARAMETERS:
- board_id (required): Board ID to get columns from. Positive integer.
  How to find: Use kaiten_list_boards to discover board_id

RETURNS: JSON array of column objects with:
- id: Column ID (use for column_id in card operations)
- title: Column name (e.g., "Backlog", "In Progress", "Testing", "Done")
- Order: Columns returned in board display order (left to right)

Not cached - fetches fresh data on every call.

USAGE EXAMPLES:
✅ DO: Get columns before creating card:
  1. kaiten_list_boards() → get board_id
  2. kaiten_list_columns(board_id) → find column_id
  3. kaiten_create_card({board_id, column_id, ...})

✅ DO: Get columns before moving card:
  1. kaiten_list_columns(board_id) → find "Code Review" column
  2. kaiten_update_card({card_id: 12345, column_id: <review_column_id>})

✅ DO: Find default/starting column (usually first or "Backlog")
✅ DO: Map column titles to IDs for user-friendly references

❌ DON'T: Hardcode column_id - columns can be reordered/renamed/deleted
❌ DON'T: Use column_id from different board - causes validation error
❌ DON'T: Skip this step when user specifies column by name - must translate to ID

ERRORS:
- NOT_FOUND (404): board_id doesn't exist or is archived
  Solution: Verify board_id with kaiten_list_boards

- AUTH_ERROR (403): No permission to view board structure
  Solution: Check API token has read access to the board's space

COLUMN BEHAVIOR:
- Columns represent horizontal workflow stages on Kanban boards
- Typical workflow: Backlog → In Progress → Review → Testing → Done
- Order returned matches visual order on board (left to right)
- First column often default for new cards
- Some boards have many columns (10+), others few (3-5)

COLUMN VS STATE:
Don't confuse with card state (1=queued, 2=in progress, 3=done):
- **column_id**: Physical position on board, board-specific stages
- **state**: Logical workflow state (1/2/3), consistent across all boards
- Cards can have any state in any column (board config dependent)
- Example: "Testing" column might have cards in state 2 (in progress)

BOARD STRUCTURE DISCOVERY WORKFLOW:
Typical sequence for creating cards with full placement:

1. kaiten_list_boards() → get board_id
2. **kaiten_list_columns(board_id)** → get column_id (stages)
3. kaiten_list_lanes(board_id) → get lane_id (swimlanes, optional)
4. kaiten_list_types(board_id) → get type_id (card types, optional)
5. kaiten_create_card({board_id, column_id, lane_id, type_id, ...})

COMMON COLUMN NAMES:
Typical column titles you'll encounter:
- Backlog, To Do, Queue
- In Progress, Doing, Work in Progress
- Code Review, Review, QA
- Testing, QA Testing
- Done, Completed, Closed
- Deployed, Released

RELATED TOOLS:
- kaiten_list_boards: Find board_id before listing columns
- kaiten_list_lanes: Get swimlanes (vertical grouping)
- kaiten_list_types: Get card types for the board
- kaiten_create_card: Create card in specific column
- kaiten_update_card: Move card to different column
- kaiten_search_cards: Filter cards by column_id`,
    inputSchema: {
      type: 'object',
      properties: {
        board_id: {
          type: 'number',
          description: 'Board ID',
        },
      },
      required: ['board_id'],
    },
  },
  {
    name: 'kaiten_list_lanes',
    description: `List board lanes (swimlanes) for vertical card grouping. Optional but useful for complex board organization.

PURPOSE: Discover lane IDs for creating/moving cards with vertical categorization. Lanes (swimlanes) provide secondary grouping orthogonal to columns, useful for team separation, priority levels, or project phases. Not all boards use lanes.

PARAMETERS:
- board_id (required): Board ID to get lanes from. Positive integer.
  How to find: Use kaiten_list_boards to discover board_id

RETURNS: JSON array of lane objects with:
- id: Lane ID (use for lane_id in card operations)
- title: Lane name (e.g., "High Priority", "Team A", "Backend")
- Order: Lanes returned in board display order (top to bottom)

Empty array [] if board has no lanes configured. Not cached - fetches fresh data.

USAGE EXAMPLES:
✅ DO: Get lanes before creating card with lane placement:
  1. kaiten_list_boards() → get board_id
  2. kaiten_list_columns(board_id) → get column_id
  3. kaiten_list_lanes(board_id) → get lane_id
  4. kaiten_create_card({board_id, column_id, lane_id, ...})

✅ DO: Check if board uses lanes:
  kaiten_list_lanes(board_id) → if empty array, board doesn't use lanes

✅ DO: Find lane by name:
  kaiten_list_lanes(board_id) → filter by title to get lane_id

✅ DO: Move card between lanes:
  kaiten_update_card({card_id: 12345, lane_id: <new_lane_id>})

❌ DON'T: Assume all boards have lanes - many don't, will return []
❌ DON'T: Use lane_id from different board - causes validation error
❌ DON'T: Require lane_id for card creation - it's always optional

ERRORS:
- NOT_FOUND (404): board_id doesn't exist or is archived
  Solution: Verify board_id with kaiten_list_boards

- AUTH_ERROR (403): No permission to view board structure
  Solution: Check API token has read access to the board's space

SWIMLANES CONCEPT:
Lanes provide VERTICAL organization on Kanban boards:
- **Columns**: Horizontal workflow stages (Backlog → In Progress → Done)
- **Lanes**: Vertical groupings (teams, priorities, categories)
- Cards positioned at intersection of column and lane

Visualization (Board Layout):
           Backlog  | In Progress | Done
High Pri   [Card A] | [Card B]    | [Card C]
Low Pri    [Card D] | [Card E]    | [Card F]
           ↑ lane      ↑ column

COMMON LANE USES:
**By Team:**
- Frontend Team
- Backend Team
- QA Team
- Design Team

**By Priority:**
- Critical
- High
- Normal
- Low

**By Product:**
- Product A
- Product B
- Infrastructure
- Shared

**By Work Type:**
- Feature Development
- Bug Fixes
- Technical Debt
- Research

LANE_ID OPTIONAL:
- Creating card: lane_id is optional parameter
- If omitted: Card goes to board's default lane
- Some boards have no lanes: lane_id not applicable
- Moving cards: Can change lane_id or omit to keep current

BOARDS WITHOUT LANES:
Many boards don't use swimlanes:
- kaiten_list_lanes returns empty array []
- Don't provide lane_id for these boards
- Cards still work fine without lane assignment
- Simpler board layout, single horizontal workflow

LANE vs COLUMN:
Don't confuse lanes with columns:
- **Columns** (required): Workflow stages, horizontal movement, all boards have them
- **Lanes** (optional): Categorization, vertical grouping, not all boards use them
- Cards have both: position = (column_id, lane_id)
- Example: Card in "In Progress" column + "Backend Team" lane

BOARD STRUCTURE DISCOVERY:
Complete workflow for card placement:

1. kaiten_list_boards() → get board_id
2. kaiten_list_columns(board_id) → get column_id (required)
3. **kaiten_list_lanes(board_id)** → get lane_id (optional, check if empty)
4. kaiten_list_types(board_id) → get type_id (optional)
5. kaiten_create_card({board_id, column_id, lane_id?, type_id?, ...})

RELATED TOOLS:
- kaiten_list_boards: Find board_id before listing lanes
- kaiten_list_columns: Get columns (required, use first for lanes)
- kaiten_list_types: Get card types for the board
- kaiten_create_card: Create card with optional lane_id
- kaiten_update_card: Move card to different lane
- kaiten_search_cards: Filter cards by lane_id`,
    inputSchema: {
      type: 'object',
      properties: {
        board_id: {
          type: 'number',
          description: 'Board ID',
        },
      },
      required: ['board_id'],
    },
  },
  {
    name: 'kaiten_list_types',
    description: `List card types available on a board. Types categorize cards by nature of work (Task, Bug, Feature, etc.).

PURPOSE: Discover valid type_id values for creating/updating cards. Card types categorize work by nature (implementation task, bug fix, feature request, etc.), help with filtering and reporting. Each board has its own type configuration.

PARAMETERS:
- board_id (required): Board ID to get card types from. Positive integer.
  How to find: Use kaiten_list_boards to discover board_id

RETURNS: JSON array of card type objects with:
- id: Type ID (use for type_id in card operations)
- name: Type name (e.g., "Task", "Bug", "Feature", "Story")
- Order: Types may be returned in priority or alphabetical order

Not cached - fetches fresh data on every call.

USAGE EXAMPLES:
✅ DO: Get types before creating card with specific type:
  1. kaiten_list_boards() → get board_id
  2. kaiten_list_types(board_id) → find "Bug" type_id
  3. kaiten_create_card({board_id, type_id: <bug_type_id>, title: "Fix login error"})

✅ DO: Find type by name:
  kaiten_list_types(board_id) → filter by name to get type_id for "Feature"

✅ DO: Change card type:
  1. kaiten_list_types(board_id) → get new type_id
  2. kaiten_update_card({card_id: 12345, type_id: <new_type_id>})

✅ DO: List available work types for user guidance:
  kaiten_list_types(board_id) → show user "Available types: Task, Bug, Feature"

❌ DON'T: Assume standard types exist - each board configures its own
❌ DON'T: Use type_id from different board - causes validation error
❌ DON'T: Hardcode type names - types vary by board and organization

ERRORS:
- NOT_FOUND (404): board_id doesn't exist or is archived
  Solution: Verify board_id with kaiten_list_boards

- AUTH_ERROR (403): No permission to view board structure
  Solution: Check API token has read access to the board's space

CARD TYPES CONCEPT:
Types categorize cards by work nature:
- **Task**: General implementation work
- **Bug**: Defect/issue that needs fixing
- **Feature**: New functionality request
- **Story**: User story (Agile/Scrum)
- **Epic**: Large initiative spanning multiple stories
- **Spike**: Research/investigation work
- **Technical Debt**: Code improvement/refactoring

Benefits:
- Better organization and filtering
- Visual distinction (types often have colors in UI)
- Reporting by work type
- Workflow customization per type

COMMON TYPE NAMES:
**Software Development:**
- Task, Bug, Feature, Story, Epic, Spike, Technical Debt, Improvement

**Project Management:**
- Action Item, Decision, Risk, Issue, Milestone

**Support/Service:**
- Ticket, Incident, Request, Question, Problem

**Marketing/Content:**
- Campaign, Content Piece, Design Asset, Review

TYPE_ID OPTIONAL:
- Creating card: type_id is optional parameter
- If omitted: Board uses default type (usually first or "Task")
- Updating card: Can change type_id or omit to keep current
- Filtering: type_id useful for search_cards to find specific work types

BOARD-SPECIFIC CONFIGURATION:
Each board has independent type configuration:
- Board A might have: Task, Bug, Feature
- Board B might have: Story, Epic, Spike, Bug
- No universal type list across all boards
- Always fetch types for specific board_id

TYPE vs STATE vs COLUMN:
Don't confuse different classification systems:
- **Type** (type_id): WHAT kind of work (Bug, Feature, Task)
- **State** (1/2/3): WORKFLOW position (Queued, In Progress, Done)
- **Column** (column_id): BOARD position (Backlog, Review, Testing)

Example: Bug (type) in In Progress (state) in Testing column (column_id)

FILTERING BY TYPE:
Use types for targeted searches:

Find all bugs:
  1. kaiten_list_types(board_id) → get bug type_id
  2. kaiten_search_cards({board_id, type_id: <bug_type_id>})

Find unresolved bugs:
  1. kaiten_list_types(board_id) → get bug type_id
  2. kaiten_search_cards({board_id, type_id: <bug_type_id>, state: 1 or 2})

BOARD STRUCTURE DISCOVERY:
Complete workflow for card creation:

1. kaiten_list_boards() → get board_id
2. kaiten_list_columns(board_id) → get column_id
3. kaiten_list_lanes(board_id) → get lane_id (if used)
4. **kaiten_list_types(board_id)** → get type_id (optional)
5. kaiten_create_card({board_id, column_id, type_id, ...})

RELATED TOOLS:
- kaiten_list_boards: Find board_id before listing types
- kaiten_list_columns: Get columns for complete board structure
- kaiten_list_lanes: Get lanes for complete board structure
- kaiten_create_card: Create card with specific type_id
- kaiten_update_card: Change card type
- kaiten_search_cards: Filter cards by type_id`,
    inputSchema: {
      type: 'object',
      properties: {
        board_id: {
          type: 'number',
          description: 'Board ID',
        },
      },
      required: ['board_id'],
    },
  },
  {
    name: 'kaiten_get_current_user',
    description: `Get information about the currently authenticated user (you) based on the API token.

PURPOSE: Verify API token is working, check your permissions, get your user_id for filtering "my cards", or confirm account details. Quick health check for API authentication.

PARAMETERS: None

RETURNS: Simplified JSON with your user information:
- id: Your user ID (use for owner_id filters, etc.)
- full_name: Your display name (Latin characters)
- email: Your email address
- username: Your login username
- activated: Account activation status (boolean true/false)

USAGE EXAMPLES:
✅ DO: Verify API token on startup:
  kaiten_get_current_user() → check if returns valid user data

✅ DO: Get your user_id for filtering:
  1. kaiten_get_current_user() → get your id
  2. kaiten_search_cards({owner_id: <your_id>}) → find "my cards"

✅ DO: Check account activation:
  kaiten_get_current_user() → verify activated: true

✅ DO: Confirm which account is authenticated:
  kaiten_get_current_user() → check full_name and email

❌ DON'T: Call repeatedly - user info rarely changes, cache the result
❌ DON'T: Use to search for other users - use kaiten_list_users instead
❌ DON'T: Expect team/organization info - returns only your user account

ERRORS:
- AUTH_ERROR (401): Invalid or expired API token
  Solution: Check KAITEN_API_TOKEN in .env file, regenerate if expired

- AUTH_ERROR (403): Token valid but lacks permissions
  Solution: Token may be restricted, check Kaiten admin settings

AUTHENTICATION:
- Uses KAITEN_API_TOKEN from environment
- Token must be active and not expired
- Tokens typically don't expire but can be revoked in Kaiten UI
- Each token belongs to one user account
- Token permissions determine API access level

RELATED TOOLS:
- kaiten_list_users: Search for other team members by name/email
- kaiten_search_cards: Filter by your owner_id to find "my cards"`,
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'kaiten_list_users',
    description: `Search for Kaiten users by name or email with server-side filtering. CRITICAL: Kaiten stores names in LATIN characters only.

PURPOSE: Find user_id to assign cards, filter by owner, or search by member. Essential preprocessing step before any user-related operations. Server supports efficient server-side filtering via query parameter.

PARAMETERS:
- query (optional but STRONGLY RECOMMENDED): Search string for filtering by full_name and email.
  CRITICAL: Kaiten API stores LATIN names only! Examples:
    ✅ "Saranyuk" (Latin) - will find "Vladimir Saranyuk"
    ❌ "Саранюк" (Cyrillic) - will return empty, names not stored in Cyrillic
  Tips: Use partial names, Latin transliteration only
- limit (optional): Max users to return. Default: 100, max: 100. Lower if you know the user.
- offset (optional): Skip N users for pagination. Default: 0. Use for iterating through large user bases.
- verbosity (optional): Response detail level - 'minimal', 'normal' (default), 'detailed'
  • Use 'minimal' when: Just need ID+name for quick reference, listing many users
  • Use 'normal' when: Need email, username, activation status - DEFAULT
  • Use 'detailed' when: Need all user metadata from API

RETURNS: JSON array with user fields (verbosity-controlled):
- id: User ID (use for owner_id, filtering)
- full_name: User's display name (Latin only!)
- email: User email address
- username: Login username
- activated: Boolean, true if user account is active

USAGE EXAMPLES:
✅ DO: Search by Latin name: kaiten_list_users({query: "Vlad"}) or {query: "Saranyuk"}
✅ DO: Search by email: kaiten_list_users({query: "vladimir@company.com"})
✅ DO: Partial match works: {query: "Sar"} finds "Saranyuk", "Sarah", "Saratov"
✅ DO: Always provide query parameter for performance (avoids loading all users)
✅ DO: Use limit to reduce response size if looking for specific person: {query: "John", limit: 10}

❌ DON'T: Use Cyrillic names: {query: "Владимир"} returns empty - LATIN ONLY!
❌ DON'T: Call without query parameter - loads ALL users (100+), wastes tokens and slow
❌ DON'T: Forget to transliterate: "Саранюк" → use "Saranyuk" (Latin transliteration)
❌ DON'T: Assume name spelling - try shorter query if not found: "Vladimir" → try "Vlad"

NAME TRANSLITERATION GUIDE:
Cyrillic → Latin conversion examples:
- Владимир → Vladimir, Vlad
- Саранюк → Saranyuk
- Алексей → Aleksey, Alex
- Юлия → Yulia, Julia, Juli
- Сергей → Sergey, Sergei
When in doubt: use first few letters or email domain

ERRORS:
- NO_RESULTS: No users match query. Solutions:
  1. Try shorter/partial query: "Vladimir" → "Vlad" → "Vl"
  2. Check transliteration: Cyrillic → Latin
  3. Try email instead of name: {query: "user@domain.com"}
  4. Verify user exists and account is activated

- TOO_MANY_RESULTS: Called without query, returning 100 users
  Solution: Add query parameter to narrow search

PERFORMANCE CRITICAL:
- WITHOUT query: Fetches up to 100 users, ~50KB response, wastes context tokens
- WITH query: Filtered server-side, typically 1-10 users, ~2KB response
- ALWAYS use query parameter unless you truly need full user list

API BEHAVIOR:
- Server-side filtering via query param (efficient, fast)
- Case-insensitive partial matching
- Searches both full_name and email fields
- Returns max 100 users per request (API limit as of mid-2025)
- Pagination via offset if needed for large teams

WORKFLOW EXAMPLE:
1. User asks: "Assign bug to Vladimir"
2. kaiten_list_users({query: "Vladimir"}) → get user_id
3. kaiten_update_card({card_id: 12345, owner_id: <user_id>})

RELATED TOOLS:
- kaiten_get_current_user: Get authenticated user info (no search needed)
- kaiten_create_card: Assign owner with owner_id parameter
- kaiten_update_card: Change card owner with owner_id parameter
- kaiten_search_cards: Filter cards by owner_id after finding user`,
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search by name/email (Latin only)',
        },
        limit: {
          type: 'number',
          description: 'Max users (default/max: 100)',
        },
        offset: {
          type: 'number',
          description: 'Skip for pagination',
        },
        verbosity: {
          type: 'string',
          description: 'Detail level: minimal (ID+name), normal (default, +email/username), detailed (full)',
        },
      },
    },
  },
  {
    name: 'kaiten_cache_invalidate_spaces',
    description: 'Invalidate spaces cache',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'kaiten_cache_invalidate_boards',
    description: 'Invalidate boards cache',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'kaiten_cache_invalidate_users',
    description: 'Invalidate users cache',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'kaiten_cache_invalidate_all',
    description: 'Invalidate all caches',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'kaiten_get_status',
    description: 'Get server status (cache/queue/config/metrics)',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'kaiten_set_log_level',
    description: 'Change logging config at runtime',
    inputSchema: {
      type: 'object',
      properties: {
        level: {
          type: 'string',
          enum: ['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency', 'off'],
          description: 'Log level',
        },
        enable_mcp_logs: {
          type: 'boolean',
          description: 'MCP logs on/off',
        },
        enable_file_logs: {
          type: 'boolean',
          description: 'File logs on/off',
        },
        enable_request_logs: {
          type: 'boolean',
          description: 'HTTP request logs on/off',
        },
        enable_metrics: {
          type: 'boolean',
          description: 'Metrics on/off',
        },
      },
      required: ['level'],
    },
  },
];

// ============================================
// SERVER SETUP
// ============================================

const server = new Server(
  {
    name: 'kaiten-mcp-server',
    version: '2.3.0',
  },
  {
    capabilities: {
      tools: {},
      resources: {
        templates: true,
        subscribe: false,
      },
      prompts: {},
      logging: {}, // Add logging capability
    },
  }
);

// Set MCP server for logger
mcpLogger.setServer(server);

// ============================================
// TOOLS HANDLER
// ============================================

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools };
});

// ============================================
// RESOURCES HANDLERS
// ============================================

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  try {
    if (!DEFAULT_SPACE_ID) {
      return { resources: [] };
    }

    // Reduced from 50 to 10 for faster startup (60-70% performance improvement)
    const cards = await kaitenClient.getCardsFromSpace(DEFAULT_SPACE_ID, 10);
    const resources = cards.map(card => ({
      uri: `kaiten-card:///${card.id}`,
      mimeType: "application/json" as const,
      name: card.title,
      description: `Card #${card.id}: ${card.title}`,
    }));

    return { resources };
  } catch (error) {
    console.error('[Kaiten MCP] Error listing resources:', error);
    return { resources: [] };
  }
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const uri = request.params.uri;

  try {
    const url = new URL(uri);
    const protocol = url.protocol.replace(':', '');
    const pathParts = url.pathname.replace(/^\/+/, '').split('/');

    if (protocol === 'kaiten-card') {
      const cardId = parseInt(pathParts[0]);
      if (isNaN(cardId)) {
        throw new Error(`Invalid card ID: ${pathParts[0]}`);
      }

      const card = await kaitenClient.getCard(cardId);
      const simplified = simplifyCard(card);

      return {
        contents: [{
          uri: uri,
          mimeType: "application/json",
          text: JSON.stringify(simplified, null, 2)
        }]
      };
    }

    if (protocol === 'kaiten-space') {
      const spaceId = parseInt(pathParts[0]);
      if (isNaN(spaceId)) {
        throw new Error(`Invalid space ID: ${pathParts[0]}`);
      }

      const space = await kaitenClient.getSpace(spaceId);

      return {
        contents: [{
          uri: uri,
          mimeType: "application/json",
          text: JSON.stringify(space, null, 2)
        }]
      };
    }

    if (protocol === 'kaiten-board') {
      const boardId = parseInt(pathParts[0]);
      if (isNaN(boardId)) {
        throw new Error(`Invalid board ID: ${pathParts[0]}`);
      }

      const cards = await kaitenClient.getCardsFromBoard(boardId, 50);
      const simplified = cards.map(simplifyCard);

      return {
        contents: [{
          uri: uri,
          mimeType: "application/json",
          text: JSON.stringify(simplified, null, 2)
        }]
      };
    }

    if (protocol === 'kaiten-current-user') {
      const user = await kaitenClient.getCurrentUser();

      return {
        contents: [{
          uri: uri,
          mimeType: "application/json",
          text: JSON.stringify(simplifyUser(user), null, 2)
        }]
      };
    }

    throw new Error(`Unsupported resource URI protocol: ${protocol}`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read resource ${uri}: ${errorMessage}`);
  }
});

server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
  return { resourceTemplates };
});

// ============================================
// PROMPTS HANDLERS
// ============================================

server.setRequestHandler(ListPromptsRequestSchema, async () => {
  return {
    prompts: [kaitenServerPrompt]
  };
});

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  if (request.params.name === kaitenServerPrompt.name) {
    return {
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: kaitenServerPromptInstructions
          }
        }
      ]
    };
  }
  throw new Error(`Prompt not found: ${request.params.name}`);
});

// ============================================
// TOOL EXECUTION HANDLER (WITH ZOD VALIDATION)
// ============================================

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const signal = (request as any)._meta?.signal; // Extract AbortSignal from request context

  if (!args) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            error: {
              type: 'MISSING_ARGUMENTS',
              message: 'Missing arguments for tool call'
            }
          })
        },
      ],
      isError: true,
    };
  }

  try {
    switch (name) {
      case 'kaiten_get_card': {
        const validatedArgs = GetCardSchema.parse(args);
        const card = await kaitenClient.getCard(validatedArgs.card_id, signal);
        const simplified = simplifyCard(card);

        // Check format parameter
        const format = validatedArgs.format || 'markdown';

        // If JSON format requested, return simplified card directly
        if (format === 'json') {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(card, null, 2),
              },
            ],
          };
        }

        // Markdown format (default)
        let output = `# ${simplified.title}\n\n`;
        output += `🔗 ${simplified.url}\n`;
        output += `📋 Board: ${simplified.board_title || 'N/A'}`;
        if (simplified.column_title) output += ` › ${simplified.column_title}`;
        if (simplified.lane_title) output += ` (${simplified.lane_title})`;
        output += `\n`;
        output += `👤 Owner: ${simplified.owner_name || 'Unassigned'}\n`;
        if (simplified.type_name) output += `🏷️ Type: ${simplified.type_name}\n`;
        if (simplified.size) output += `📊 Size: ${simplified.size}\n`;
        if (simplified.due_date) output += `📅 Due: ${simplified.due_date}\n`;
        if (simplified.asap) output += `⚡ ASAP\n`;
        if (simplified.blocked) {
          output += `🚫 BLOCKED`;
          if (simplified.block_reason) output += `: ${simplified.block_reason}`;
          output += `\n`;
          if (simplified.blocker_name) output += `   Blocker: ${simplified.blocker_name}\n`;
        }
        if (simplified.tags.length > 0) output += `🏷️ Tags: ${simplified.tags.join(', ')}\n`;
        if (simplified.members.length > 0) output += `👥 Members: ${simplified.members.join(', ')}\n`;
        output += `💬 Comments: ${simplified.comments_total}`;
        if (simplified.last_comment_date) output += ` (last: ${simplified.last_comment_date})`;
        output += `\n`;
        output += `🕐 Created: ${simplified.created || 'N/A'} | Updated: ${simplified.updated || 'N/A'}\n`;

        // Add card relationships info (from API counts)
        const hasParents = card.parents_count && card.parents_count > 0;
        const hasChildren = card.children_count && card.children_count > 0;

        if (hasParents || hasChildren) {
          output += `\n## 🔗 Related Cards\n`;

          if (hasParents) {
            output += `📌 Parent cards: ${card.parents_count}\n`;
          }

          if (hasChildren) {
            const doneCount = card.children_done || 0;
            const totalCount = card.children_count || 0;
            const progress = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;
            output += `📋 Subtasks: ${doneCount}/${totalCount} done (${progress}%)\n\n`;

            // Fetch children cards to show detailed list
            try {
              const children = await kaitenClient.getCardChildren(validatedArgs.card_id, signal);
              if (children && children.length > 0) {
                // Fetch full details for blocked cards (to get blocking reason)
                const childrenWithBlockingDetails = await Promise.all(
                  children.map(async (child) => {
                    if (child.blocked) {
                      try {
                        const fullCard = await kaitenClient.getCard(child.id, signal);
                        return fullCard;
                      } catch (error) {
                        safeLog.warn(`Failed to fetch blocking details for card ${child.id}: ${error}`);
                        return child;
                      }
                    }
                    return child;
                  })
                );

                childrenWithBlockingDetails.forEach((child, index) => {
                  const baseUrl = API_URL!.replace('/api/latest', '');
                  const childSpaceId = child.space_id || child.board?.space_id || DEFAULT_SPACE_ID || '';
                  const childUrl = `${baseUrl}/space/${childSpaceId}/card/${child.id}`;

                  // State icons: 1=queued (⏳), 2=in progress (🔄), 3=done (✅)
                  const stateIcon = child.state === 3 ? '✅' : child.state === 2 ? '🔄' : '⏳';
                  const ownerInfo = child.owner?.full_name ? ` · ${child.owner.full_name}` : '';

                  // Blocking info
                  const blockIcon = child.blocked ? ' 🚫' : '';

                  output += `${index + 1}. ${stateIcon} [#${child.id}] ${child.title}${blockIcon}${ownerInfo}\n`;

                  if (child.blocked && child.blockers && child.blockers.length > 0 && child.blockers[0].reason) {
                    output += `   🚫 ${child.blockers[0].reason}\n`;
                  }

                  output += `   ${childUrl}\n`;
                });
              }
            } catch (error) {
              safeLog.warn(`Failed to fetch children cards: ${error}`);
              output += `\nℹ️ Unable to load child cards details. Use kaiten_search_cards to find them.\n`;
            }
          }

          if (hasParents) {
            output += `\nℹ️ To view parent card details, search by parent card ID in Kaiten.\n`;
          }
        }

        if (simplified.description) {
          output += `\n## Description\n${simplified.description}\n`;
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: output,
            },
          ],
        };
      }

      case 'kaiten_create_card': {
        const validatedArgs = CreateCardSchema.parse(args);
        const params: CreateCardParams = {
          title: validatedArgs.title,
          board_id: validatedArgs.board_id,
        };
        if (validatedArgs.column_id) params.column_id = validatedArgs.column_id;
        if (validatedArgs.lane_id) params.lane_id = validatedArgs.lane_id;
        if (validatedArgs.description) params.description = validatedArgs.description;
        if (validatedArgs.type_id) params.type_id = validatedArgs.type_id;
        if (validatedArgs.size !== undefined) params.size = validatedArgs.size;
        if (validatedArgs.asap !== undefined) params.asap = validatedArgs.asap;
        if (validatedArgs.owner_id) params.owner_id = validatedArgs.owner_id;
        if (validatedArgs.due_date) params.due_date = validatedArgs.due_date;

        const card = await kaitenClient.createCard(params, signal);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(card, null, 2),
            },
          ],
        };
      }

      case 'kaiten_update_card': {
        const validatedArgs = UpdateCardSchema.parse(args);
        const params: UpdateCardParams = {};
        if (validatedArgs.title) params.title = validatedArgs.title;
        if (validatedArgs.description !== undefined) params.description = validatedArgs.description;
        if (validatedArgs.state !== undefined) params.state = validatedArgs.state;
        if (validatedArgs.column_id) params.column_id = validatedArgs.column_id;
        if (validatedArgs.lane_id) params.lane_id = validatedArgs.lane_id;
        if (validatedArgs.type_id) params.type_id = validatedArgs.type_id;
        if (validatedArgs.size !== undefined) params.size = validatedArgs.size;
        if (validatedArgs.asap !== undefined) params.asap = validatedArgs.asap;
        if (validatedArgs.owner_id) params.owner_id = validatedArgs.owner_id;
        if (validatedArgs.due_date) params.due_date = validatedArgs.due_date;

        const card = await kaitenClient.updateCard(validatedArgs.card_id, params, signal);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(card, null, 2),
            },
          ],
        };
      }

      case 'kaiten_delete_card': {
        const validatedArgs = DeleteCardSchema.parse(args);
        await kaitenClient.deleteCard(validatedArgs.card_id, signal);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Card ${validatedArgs.card_id} deleted successfully`,
            },
          ],
        };
      }

      case 'kaiten_get_card_comments': {
        const validatedArgs = GetCardCommentsSchema.parse(args);
        const comments = await kaitenClient.getCardComments(validatedArgs.card_id, signal);
        const simplified = comments.map(simplifyComment);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(simplified, null, 2),
            },
          ],
        };
      }

      case 'kaiten_create_comment': {
        const validatedArgs = CreateCommentSchema.parse(args);
        const comment = await kaitenClient.createComment(
          validatedArgs.card_id,
          validatedArgs.text,
          undefined,
          signal
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(comment, null, 2),
            },
          ],
        };
      }

      case 'kaiten_update_comment': {
        const validatedArgs = UpdateCommentSchema.parse(args);
        const comment = await kaitenClient.updateComment(
          validatedArgs.card_id,
          validatedArgs.comment_id,
          validatedArgs.text,
          undefined,
          signal
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(comment, null, 2),
            },
          ],
        };
      }

      case 'kaiten_delete_comment': {
        const validatedArgs = DeleteCommentSchema.parse(args);
        await kaitenClient.deleteComment(validatedArgs.card_id, validatedArgs.comment_id, signal);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Comment ${validatedArgs.comment_id} deleted successfully`,
            },
          ],
        };
      }

      case 'kaiten_search_cards': {
        const validatedArgs = SearchCardsSchema.parse(args);
        const searchParams: any = {};

        // Text search
        if (validatedArgs.query) searchParams.query = validatedArgs.query;
        if (validatedArgs.title) searchParams.title = validatedArgs.title;

        // Handle space_id logic
        if (validatedArgs.space_id !== undefined && validatedArgs.space_id !== null && validatedArgs.space_id !== 0) {
          searchParams.space_id = validatedArgs.space_id;
        } else if (validatedArgs.space_id === undefined && DEFAULT_SPACE_ID) {
          searchParams.space_id = DEFAULT_SPACE_ID;
        }

        // Basic filters
        if (validatedArgs.board_id) searchParams.board_id = validatedArgs.board_id;
        if (validatedArgs.column_id) searchParams.column_id = validatedArgs.column_id;
        if (validatedArgs.lane_id) searchParams.lane_id = validatedArgs.lane_id;
        if (validatedArgs.state !== undefined) searchParams.state = validatedArgs.state;
        if (validatedArgs.owner_id) searchParams.owner_id = validatedArgs.owner_id;
        if (validatedArgs.type_id) searchParams.type_id = validatedArgs.type_id;
        searchParams.condition = validatedArgs.condition !== undefined ? validatedArgs.condition : 1;

        // Date filters
        if (validatedArgs.created_before) searchParams.created_before = validatedArgs.created_before;
        if (validatedArgs.created_after) searchParams.created_after = validatedArgs.created_after;
        if (validatedArgs.updated_before) searchParams.updated_before = validatedArgs.updated_before;
        if (validatedArgs.updated_after) searchParams.updated_after = validatedArgs.updated_after;
        if (validatedArgs.due_date_before) searchParams.due_date_before = validatedArgs.due_date_before;
        if (validatedArgs.due_date_after) searchParams.due_date_after = validatedArgs.due_date_after;
        if (validatedArgs.last_moved_to_done_at_before) searchParams.last_moved_to_done_at_before = validatedArgs.last_moved_to_done_at_before;
        if (validatedArgs.last_moved_to_done_at_after) searchParams.last_moved_to_done_at_after = validatedArgs.last_moved_to_done_at_after;

        // Boolean flags
        if (validatedArgs.asap !== undefined) searchParams.asap = validatedArgs.asap;
        if (validatedArgs.archived !== undefined) searchParams.archived = validatedArgs.archived;
        if (validatedArgs.overdue !== undefined) searchParams.overdue = validatedArgs.overdue;
        if (validatedArgs.done_on_time !== undefined) searchParams.done_on_time = validatedArgs.done_on_time;
        if (validatedArgs.with_due_date !== undefined) searchParams.with_due_date = validatedArgs.with_due_date;

        // Multiple IDs (comma-separated)
        if (validatedArgs.owner_ids) searchParams.owner_ids = validatedArgs.owner_ids;
        if (validatedArgs.member_ids) searchParams.member_ids = validatedArgs.member_ids;
        if (validatedArgs.column_ids) searchParams.column_ids = validatedArgs.column_ids;
        if (validatedArgs.type_ids) searchParams.type_ids = validatedArgs.type_ids;
        if (validatedArgs.tag_ids) searchParams.tag_ids = validatedArgs.tag_ids;

        // Exclude filters
        if (validatedArgs.exclude_board_ids) searchParams.exclude_board_ids = validatedArgs.exclude_board_ids;
        if (validatedArgs.exclude_owner_ids) searchParams.exclude_owner_ids = validatedArgs.exclude_owner_ids;
        if (validatedArgs.exclude_card_ids) searchParams.exclude_card_ids = validatedArgs.exclude_card_ids;

        // Sorting and pagination
        if (validatedArgs.sort_by) searchParams.sort_by = validatedArgs.sort_by;
        if (validatedArgs.sort_direction) searchParams.sort_direction = validatedArgs.sort_direction;
        if (validatedArgs.limit) searchParams.limit = validatedArgs.limit;
        if (validatedArgs.skip) searchParams.skip = validatedArgs.skip;

        const cards = await kaitenClient.searchCards(searchParams, signal);

        // Apply verbosity control
        const verbosity = validatedArgs.verbosity || 'normal';
        const processedCards = applyCardVerbosity(cards, verbosity, simplifyCardCompact);

        // Warn if returning many cards without space_id filter
        const effectiveLimit = validatedArgs.limit || 10;
        if (effectiveLimit > 20 && !searchParams.space_id) {
          safeLog.warn(`[Kaiten MCP] Large search result (limit=${effectiveLimit}) without space_id filter may cause context overflow. Consider adding space_id or board_id.`);
        }

        // Create human-readable summary
        let summary = `Found ${cards.length} card(s)`;
        if (validatedArgs.query) summary += ` matching "${validatedArgs.query}"`;
        if (searchParams.space_id) summary += ` in space ${searchParams.space_id}`;
        if (validatedArgs.board_id) summary += ` on board ${validatedArgs.board_id}`;
        summary += `\nVerbosity: ${verbosity}\n\n`;

        // Format based on verbosity
        if (verbosity === 'minimal') {
          // Minimal: just ID, title, board
          processedCards.forEach((card, index) => {
            summary += `${index + 1}. [${card.id}] ${card.title}\n`;
          });
        } else {
          // Normal/detailed: include more details
          processedCards.forEach((card, index) => {
            summary += `${index + 1}. ${card.title}\n`;
            summary += `   📋 Board: ${card.board_title || 'N/A'}\n`;
            summary += `   👤 Owner: ${card.owner_name || 'Unassigned'}\n`;
            if (card.asap) summary += `   ⚡ ASAP\n`;
            if (card.blocked) summary += `   🚫 BLOCKED\n`;
            summary += `   🔗 ${card.url}\n`;
            summary += `   🕐 Updated: ${card.updated || 'N/A'}\n\n`;
          });
        }

        summary += `\nℹ️ Use kaiten_get_card with card ID for full details.`;

        // Apply truncation if response is too large
        const finalResponse = truncateResponse(summary);

        return {
          content: [
            {
              type: 'text' as const,
              text: finalResponse,
            },
          ],
        };
      }

      case 'kaiten_get_space_cards': {
        const validatedArgs = GetSpaceCardsSchema.parse(args);
        const condition = validatedArgs.condition !== undefined ? validatedArgs.condition : 1;
        const cards = await kaitenClient.getCardsFromSpace(
          validatedArgs.space_id,
          validatedArgs.limit,
          validatedArgs.skip,
          condition,
          signal
        );

        // Apply verbosity control
        const verbosity = validatedArgs.verbosity || 'normal';
        const processedCards = applyCardVerbosity(cards, verbosity, simplifyCardCompact);

        // Human-readable format (similar to search)
        let output = `Found ${cards.length} card(s) in space ${validatedArgs.space_id}\n`;
        output += `Verbosity: ${verbosity}\n\n`;

        // Format based on verbosity
        if (verbosity === 'minimal') {
          processedCards.forEach((card, index) => {
            output += `${index + 1}. [${card.id}] ${card.title}\n`;
          });
        } else {
          processedCards.forEach((card, index) => {
            output += `${index + 1}. ${card.title}\n`;
            output += `   📋 Board: ${card.board_title || 'N/A'}\n`;
            output += `   👤 Owner: ${card.owner_name || 'Unassigned'}\n`;
            if (card.asap) output += `   ⚡ ASAP\n`;
            if (card.blocked) output += `   🚫 BLOCKED\n`;
            output += `   🔗 ${card.url}\n`;
            output += `   🕐 Updated: ${card.updated || 'N/A'}\n\n`;
          });
        }
        output += `\nℹ️ Use kaiten_get_card for full details.`;

        // Apply truncation
        const finalOutput = truncateResponse(output);

        return {
          content: [
            {
              type: 'text' as const,
              text: finalOutput,
            },
          ],
        };
      }

      case 'kaiten_get_board_cards': {
        const validatedArgs = GetBoardCardsSchema.parse(args);
        const condition = validatedArgs.condition !== undefined ? validatedArgs.condition : 1;
        const cards = await kaitenClient.getCardsFromBoard(
          validatedArgs.board_id,
          validatedArgs.limit,
          validatedArgs.skip,
          condition,
          signal
        );

        // Apply verbosity control
        const verbosity = validatedArgs.verbosity || 'normal';
        const processedCards = applyCardVerbosity(cards, verbosity, simplifyCardCompact);

        // Human-readable format (similar to search)
        let output = `Found ${cards.length} card(s) on board ${validatedArgs.board_id}\n`;
        output += `Verbosity: ${verbosity}\n\n`;

        // Format based on verbosity
        if (verbosity === 'minimal') {
          processedCards.forEach((card, index) => {
            output += `${index + 1}. [${card.id}] ${card.title}\n`;
          });
        } else {
          processedCards.forEach((card, index) => {
            output += `${index + 1}. ${card.title}\n`;
            output += `   📋 Board: ${card.board_title || 'N/A'}\n`;
            output += `   👤 Owner: ${card.owner_name || 'Unassigned'}\n`;
            if (card.asap) output += `   ⚡ ASAP\n`;
            if (card.blocked) output += `   🚫 BLOCKED\n`;
            output += `   🔗 ${card.url}\n`;
            output += `   🕐 Updated: ${card.updated || 'N/A'}\n\n`;
          });
        }
        output += `\nℹ️ Use kaiten_get_card for full details.`;

        // Apply truncation
        const finalOutput = truncateResponse(output);

        return {
          content: [
            {
              type: 'text' as const,
              text: finalOutput,
            },
          ],
        };
      }

      case 'kaiten_list_spaces': {
        // Try cache first
        let spaces = cache.getSpaces();
        if (!spaces) {
          spaces = await kaitenClient.getSpaces(signal);
          cache.setSpaces(spaces);
        }
        const simplified = spaces.map(simplifySpace);

        // Human-readable format
        let output = `Found ${simplified.length} space(s):\n\n`;
        simplified.forEach((space, index) => {
          output += `${index + 1}. ${space.title} (ID: ${space.id})`;
          if (space.archived) output += ` [ARCHIVED]`;
          output += `\n`;
          if (space.boards && space.boards.length > 0) {
            output += `   📋 Boards (${space.boards.length}): ${space.boards.map(b => b.title).join(', ')}\n`;
          }
          output += `\n`;
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: output,
            },
          ],
        };
      }

      case 'kaiten_get_space': {
        const validatedArgs = GetSpaceSchema.parse(args);

        // Try cache first
        let space = cache.getSpace(validatedArgs.space_id);
        if (!space) {
          space = await kaitenClient.getSpace(validatedArgs.space_id, signal);
          cache.setSpace(validatedArgs.space_id, space);
        }

        // Apply format parameter
        const format = validatedArgs.format || 'markdown';
        const response = applyResponseFormat(space, format, `Space: ${space.title}`);

        return {
          content: [
            {
              type: 'text' as const,
              text: response,
            },
          ],
        };
      }

      case 'kaiten_list_boards': {
        const validatedArgs = ListBoardsSchema.parse(args);

        // spaceId is now required by API - use provided or fallback to DEFAULT_SPACE_ID
        const spaceId = validatedArgs.space_id || DEFAULT_SPACE_ID;

        if (!spaceId) {
          throw new Error(
            'space_id is required. Set KAITEN_DEFAULT_SPACE_ID environment variable or provide space_id parameter.'
          );
        }

        // Try cache first
        let boards = cache.getBoards(spaceId);
        if (!boards) {
          boards = await kaitenClient.getBoards(spaceId, signal);
          cache.setBoards(boards, spaceId);
        }

        // Apply verbosity control
        const verbosity = validatedArgs.verbosity || 'normal';
        const processedBoards = applyBoardVerbosity(boards, verbosity);

        const output = truncateResponse(JSON.stringify(processedBoards, null, 2));

        return {
          content: [
            {
              type: 'text' as const,
              text: output,
            },
          ],
        };
      }

      case 'kaiten_get_board': {
        const validatedArgs = GetBoardSchema.parse(args);

        // Try cache first
        let board = cache.getBoard(validatedArgs.board_id);
        if (!board) {
          board = await kaitenClient.getBoard(validatedArgs.board_id, signal);
          cache.setBoard(validatedArgs.board_id, board);
        }

        // Apply format parameter
        const format = validatedArgs.format || 'markdown';
        const response = applyResponseFormat(board, format, `Board: ${board.title}`);

        return {
          content: [
            {
              type: 'text' as const,
              text: response,
            },
          ],
        };
      }

      case 'kaiten_list_columns': {
        const validatedArgs = ListColumnsSchema.parse(args);
        const columns = await kaitenClient.getColumns(validatedArgs.board_id, signal);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(columns, null, 2),
            },
          ],
        };
      }

      case 'kaiten_list_lanes': {
        const validatedArgs = ListLanesSchema.parse(args);
        const lanes = await kaitenClient.getLanes(validatedArgs.board_id, signal);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(lanes, null, 2),
            },
          ],
        };
      }

      case 'kaiten_list_types': {
        const validatedArgs = ListTypesSchema.parse(args);
        const types = await kaitenClient.getTypes(validatedArgs.board_id, signal);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(types, null, 2),
            },
          ],
        };
      }

      case 'kaiten_get_current_user': {
        const user = await kaitenClient.getCurrentUser(signal);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(user, null, 2),
            },
          ],
        };
      }

      case 'kaiten_list_users': {
        const validatedArgs = ListUsersSchema.parse(args);

        // Use server-side filtering when parameters provided
        // /users endpoint supports query, limit, and offset for server-side filtering
        if (validatedArgs.query || validatedArgs.limit || validatedArgs.offset) {
          const users = await kaitenClient.getUsers({
            query: validatedArgs.query,
            limit: validatedArgs.limit,
            offset: validatedArgs.offset,
          }, signal);

          // Apply verbosity control
          const verbosity = validatedArgs.verbosity || 'normal';
          const processedUsers = applyUserVerbosity(users, verbosity);

          const output = truncateResponse(JSON.stringify(processedUsers, null, 2));

          return {
            content: [
              {
                type: 'text' as const,
                text: output,
              },
            ],
          };
        }

        // Fallback: cache full list when no parameters
        // Note: Starting mid-July, /users endpoint returns max 100 users per request
        safeLog.warn('[Kaiten MCP] WARNING: kaiten_list_users called without parameters. Consider using query parameter for better performance.');

        let allUsers = cache.getUsers();
        if (!allUsers) {
          allUsers = await kaitenClient.getUsers(undefined, signal);
          cache.setUsers(allUsers);
        }

        // Apply verbosity control
        const verbosity = validatedArgs.verbosity || 'normal';
        const processedUsers = applyUserVerbosity(allUsers, verbosity);

        const output = truncateResponse(JSON.stringify(processedUsers, null, 2));

        return {
          content: [
            {
              type: 'text' as const,
              text: output,
            },
          ],
        };
      }

      case 'kaiten_cache_invalidate_spaces': {
        cache.invalidateSpaces();
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ message: 'Spaces cache invalidated successfully' }, null, 2),
            },
          ],
        };
      }

      case 'kaiten_cache_invalidate_boards': {
        cache.invalidateBoards();
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ message: 'Boards cache invalidated successfully' }, null, 2),
            },
          ],
        };
      }

      case 'kaiten_cache_invalidate_users': {
        cache.invalidateUsers();
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ message: 'Users cache invalidated successfully' }, null, 2),
            },
          ],
        };
      }

      case 'kaiten_cache_invalidate_all': {
        cache.invalidateAll();
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ message: 'All caches invalidated successfully' }, null, 2),
            },
          ],
        };
      }

      case 'kaiten_get_status': {
        const status = {
          version: '2.3.0',
          config: {
            api_url: config.KAITEN_API_URL,
            default_space_id: config.KAITEN_DEFAULT_SPACE_ID || null,
            max_concurrent_requests: config.KAITEN_MAX_CONCURRENT_REQUESTS,
            cache_ttl_seconds: config.KAITEN_CACHE_TTL_SECONDS,
            request_timeout_ms: config.KAITEN_REQUEST_TIMEOUT_MS,
          },
          cache: cache.getStats(),
          queue: kaitenClient.getQueueStatus(),
          logging: logger.getConfig(),
          metrics: logger.getMetrics(),
        };

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(status, null, 2),
            },
          ],
        };
      }

      case 'kaiten_set_log_level': {
        const validatedArgs = SetLogLevelSchema.parse(args);
        const { level, enable_mcp_logs, enable_file_logs, enable_request_logs, enable_metrics } = validatedArgs;

        const newConfig: any = {};

        if (level === 'off') {
          newConfig.enabled = false;
        } else {
          newConfig.enabled = true;
          newConfig.level = level as LogLevel;
        }

        if (enable_mcp_logs !== undefined) newConfig.mcpEnabled = enable_mcp_logs;
        if (enable_file_logs !== undefined) newConfig.fileEnabled = enable_file_logs;
        if (enable_request_logs !== undefined) {
          process.env.KAITEN_LOG_REQUESTS = enable_request_logs ? 'true' : 'false';
        }
        if (enable_metrics !== undefined) newConfig.metricsEnabled = enable_metrics;

        logger.updateConfig(newConfig);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                message: 'Logging configuration updated successfully',
                config: logger.getConfig(),
              }, null, 2),
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error: any) {
    // Handle Zod validation errors
    if (error instanceof z.ZodError) {
      const formattedErrors = error.errors.map(err => ({
        path: err.path.join('.'),
        message: err.message,
        code: err.code
      }));

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              error: {
                type: 'VALIDATION_ERROR',
                message: 'Invalid request parameters',
                details: formattedErrors
              }
            }, null, 2),
          },
        ],
        isError: true,
      };
    }

    // Handle Axios/API errors
    if (error.response) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              error: {
                type: 'API_ERROR',
                message: error.message || 'Kaiten API error',
                status: error.response.status,
                details: error.response.data
              }
            }, null, 2),
          },
        ],
        isError: true,
      };
    }

    // Handle unknown errors
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            error: {
              type: 'UNKNOWN_ERROR',
              message: error.message || String(error)
            }
          }, null, 2),
        },
      ],
      isError: true,
    };
  }
});

// ============================================
// START SERVER
// ============================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('Kaiten MCP Server started', {
    version: '2.3.0',
    tools: tools.length,
    logging_enabled: logger.getConfig().enabled,
  }, 'main');
  console.error('Kaiten MCP Server v2.3.0 running on stdio');
  console.error(`- Tools: ${tools.length} available`);
  console.error('- Resources: Enabled (cards, spaces, boards)');
  console.error('- Prompts: Server prompt configured');
  console.error('- Validation: Zod schemas active');
  console.error('- Logging: Runtime control available via kaiten_set_log_level');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
