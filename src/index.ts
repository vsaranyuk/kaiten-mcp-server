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
} from './schemas.js';

// Config is loaded and validated in config.ts
const API_URL = config.KAITEN_API_URL;
const API_TOKEN = config.KAITEN_API_TOKEN;
const DEFAULT_SPACE_ID = config.KAITEN_DEFAULT_SPACE_ID;

if (DEFAULT_SPACE_ID) {
  safeLog.info(`Using default space ID: ${DEFAULT_SPACE_ID}`);
}

// Initialize Kaiten client (with retry, backoff, concurrency control)
const kaitenClient = new KaitenClient(API_URL, API_TOKEN);

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

const kaitenServerPromptInstructions = `This server provides access to Kaiten, a project management and task tracking system. Use it to manage cards, collaborate on tasks, and organize work across boards and spaces.

Key capabilities:
- Card management: Create, read, update, delete, and search cards with rich metadata
- Comments: Full comment lifecycle management for collaboration
- Spaces and boards: Navigate organizational structure and access board-specific cards
- Default Space: Configured default space for streamlined operations
- Advanced search: Find cards using flexible filters including text search, board/space filtering, and status filters

Tool Usage:

- kaiten_create_card:
  - Required: title, board_id
  - Use kaiten_list_boards or kaiten_get_space to find valid board_ids
  - Optional fields: description (supports markdown), size (story points), asap (urgent flag), owner_id, due_date (ISO format)
  - Example: Create bug report cards with high priority, assign to team members

- kaiten_update_card:
  - Required: card_id
  - Only include fields you want to change
  - state: card state number (varies by board workflow)
  - Can move cards between columns/lanes by specifying column_id/lane_id

- kaiten_search_cards:
  - IMPORTANT: By default searches in configured default space (KAITEN_DEFAULT_SPACE_ID)
  - query: uses partial case-insensitive matching in title, description, and comments
    - Use root words for better results (e.g., "болгар" matches "Болгария", "болгарский")
  - space_id: omit for default space, set to 0 or null for ALL spaces, or provide specific space_id
  - board_id: RECOMMENDED to narrow results and avoid large responses
  - condition: 1=active cards (default), 2=archived cards (only when explicitly requested)
  - sort_by: created (default), updated, title
  - sort_direction: desc (newest first, default), asc
  - limit: default 10, max 100
  - Example filters: owner_id, type_id, state, column_id, lane_id

- kaiten_get_space_cards / kaiten_get_board_cards:
  - Returns newest active cards by default (sorted by creation date DESC)
  - limit: default 10, specify different number only if user explicitly requests
  - condition: 1=active (default), 2=archived (only when user explicitly asks)
  - Use these for browsing cards in a specific context

- kaiten_create_comment / kaiten_update_comment:
  - Comments support plain text and markdown
  - Useful for updates, discussions, and tracking progress
  - Comments appear in card history and activity feed

- kaiten_list_spaces / kaiten_get_space:
  - Use to discover available spaces and their boards
  - Spaces organize work at the highest level (e.g., by department, project)

- kaiten_list_boards / kaiten_get_board:
  - Boards contain cards organized in columns and lanes
  - Each board can have custom workflows, card types, and fields

- kaiten_get_current_user:
  - Get information about the authenticated user
  - Returns user ID, name, email, and permissions

- kaiten_list_users:
  - IMPORTANT: ALWAYS use query parameter to search for specific users
  - NEVER call without query parameter - will return ALL users and fill context window
  - Query searches in: full_name, email, username (case-insensitive, partial match)
  - Examples: query="иванов" finds "Иван Иванов", query="john" finds "John Smith", "john.doe@example.com"
  - Use for finding user IDs to assign cards (owner_id field)
  - If user not found with query, try broader search or check spelling

Best practices:

- When creating cards:
  - Write clear, actionable titles describing the task (e.g., "Fix authentication bug in mobile app")
  - Include detailed descriptions with context, acceptance criteria, and relevant links
  - Set appropriate size estimates for sprint planning
  - To assign a card: use kaiten_list_users with query parameter to find user by name/email, then use their ID in owner_id
  - Use asap flag only for truly urgent items

- When searching:
  - Start with query parameter for text-based search
  - Add board_id to narrow results and improve performance
  - Use condition=1 (default) for active cards; only search archived when needed
  - If no results with query, try broader search or omit query to browse
  - Remember: by default searches in default space unless you specify otherwise

- When updating cards:
  - Only include fields that need to change
  - Check current card state before updating to understand context
  - Use comments to explain significant changes

- Performance optimization:
  - Always prefer board-scoped operations (kaiten_get_board_cards) over space-scoped when possible
  - Use appropriate limit values to avoid large responses
  - Search with specific filters rather than fetching all cards and filtering locally

- Default Space workflow:
  - Most operations automatically use KAITEN_DEFAULT_SPACE_ID
  - Users can say "find card about X" and it searches default space
  - To search other spaces: "find card about X in space 456" or "in all spaces"

- When working with users:
  - ALWAYS search users with query parameter: kaiten_list_users(query="lastname")
  - NEVER fetch all users without query - wastes tokens and may hit context limits
  - Use partial names/emails for flexible matching

Resource patterns:
- kaiten-card:///{cardId} - Single card with full details (e.g., kaiten-card:///12345)
- kaiten-space:///{spaceId} - Space with boards list (e.g., kaiten-space:///12345)
- kaiten-board:///{boardId}/cards - All cards in board (e.g., kaiten-board:///54321/cards)
- kaiten-current-user: - Current authenticated user context

Error handling:
- Validation errors provide detailed field-level feedback
- API errors include response status and details
- Card not found: check card_id and user permissions
- Large response warnings: add board_id filter or reduce limit

The server uses the authenticated user's permissions for all operations. Cards, spaces, and boards not accessible to the token will not be visible.`;

// ============================================
// TOOLS DEFINITIONS
// ============================================

const tools: Tool[] = [
  {
    name: 'kaiten_get_card',
    description: 'Get a card by ID with all its details including title, description, fields, and properties',
    inputSchema: {
      type: 'object',
      properties: {
        card_id: {
          type: 'number',
          description: 'The ID of the card to retrieve',
        },
      },
      required: ['card_id'],
    },
  },
  {
    name: 'kaiten_create_card',
    description: 'Create a new card with title, description, and other fields',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'The title of the card',
        },
        board_id: {
          type: 'number',
          description: 'The ID of the board where the card will be created',
        },
        column_id: {
          type: 'number',
          description: 'The ID of the column (optional)',
        },
        lane_id: {
          type: 'number',
          description: 'The ID of the lane (optional)',
        },
        description: {
          type: 'string',
          description: 'The description of the card (optional)',
        },
        type_id: {
          type: 'number',
          description: 'The type ID of the card (optional)',
        },
        size: {
          type: 'number',
          description: 'The size/estimate of the card (optional)',
        },
        asap: {
          type: 'boolean',
          description: 'Mark as ASAP (optional)',
        },
        owner_id: {
          type: 'number',
          description: 'The ID of the card owner (optional)',
        },
        due_date: {
          type: 'string',
          description: 'Due date in ISO format (optional)',
        },
      },
      required: ['title', 'board_id'],
    },
  },
  {
    name: 'kaiten_update_card',
    description: 'Update a card\'s title, description, status, or other fields',
    inputSchema: {
      type: 'object',
      properties: {
        card_id: {
          type: 'number',
          description: 'The ID of the card to update',
        },
        title: {
          type: 'string',
          description: 'The new title (optional)',
        },
        description: {
          type: 'string',
          description: 'The new description (optional)',
        },
        state: {
          type: 'number',
          description: 'The new state (optional)',
        },
        column_id: {
          type: 'number',
          description: 'Move to this column ID (optional)',
        },
        lane_id: {
          type: 'number',
          description: 'Move to this lane ID (optional)',
        },
        type_id: {
          type: 'number',
          description: 'The new type ID (optional)',
        },
        size: {
          type: 'number',
          description: 'The new size/estimate (optional)',
        },
        asap: {
          type: 'boolean',
          description: 'Mark as ASAP (optional)',
        },
        owner_id: {
          type: 'number',
          description: 'The new owner ID (optional)',
        },
        due_date: {
          type: 'string',
          description: 'New due date in ISO format (optional)',
        },
      },
      required: ['card_id'],
    },
  },
  {
    name: 'kaiten_delete_card',
    description: 'Delete a card by ID',
    inputSchema: {
      type: 'object',
      properties: {
        card_id: {
          type: 'number',
          description: 'The ID of the card to delete',
        },
      },
      required: ['card_id'],
    },
  },
  {
    name: 'kaiten_get_card_comments',
    description: 'Get all comments for a specific card',
    inputSchema: {
      type: 'object',
      properties: {
        card_id: {
          type: 'number',
          description: 'The ID of the card',
        },
      },
      required: ['card_id'],
    },
  },
  {
    name: 'kaiten_create_comment',
    description: 'Create a comment on a card',
    inputSchema: {
      type: 'object',
      properties: {
        card_id: {
          type: 'number',
          description: 'The ID of the card',
        },
        text: {
          type: 'string',
          description: 'The comment text',
        },
      },
      required: ['card_id', 'text'],
    },
  },
  {
    name: 'kaiten_update_comment',
    description: 'Update an existing comment',
    inputSchema: {
      type: 'object',
      properties: {
        card_id: {
          type: 'number',
          description: 'The ID of the card',
        },
        comment_id: {
          type: 'number',
          description: 'The ID of the comment to update',
        },
        text: {
          type: 'string',
          description: 'The new comment text',
        },
      },
      required: ['card_id', 'comment_id', 'text'],
    },
  },
  {
    name: 'kaiten_delete_comment',
    description: 'Delete a comment from a card',
    inputSchema: {
      type: 'object',
      properties: {
        card_id: {
          type: 'number',
          description: 'The ID of the card',
        },
        comment_id: {
          type: 'number',
          description: 'The ID of the comment to delete',
        },
      },
      required: ['card_id', 'comment_id'],
    },
  },
  {
    name: 'kaiten_search_cards',
    description: 'Search for cards with flexible filters. By default: searches in configured default space, returns 10 newest active cards, sorted by creation date DESC.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query for partial case-insensitive matching. Searches in card title, description, and comments. Use root words for better results (e.g., "болгар" instead of "болгария" to match all forms). If no results, try without query parameter.',
        },
        space_id: {
          type: 'number',
          description: 'Filter by space ID. By default (omit parameter), searches in configured default space. To search in ALL spaces, explicitly set to 0 or null when user asks "search everywhere" or "in all spaces". To search specific space, provide space ID.',
        },
        board_id: {
          type: 'number',
          description: 'Filter by board ID (RECOMMENDED to avoid large responses)',
        },
        column_id: {
          type: 'number',
          description: 'Filter by column ID (optional)',
        },
        lane_id: {
          type: 'number',
          description: 'Filter by lane ID (optional)',
        },
        title: {
          type: 'string',
          description: 'Filter by title (optional)',
        },
        state: {
          type: 'number',
          description: 'Filter by state (optional)',
        },
        owner_id: {
          type: 'number',
          description: 'Filter by owner ID (optional)',
        },
        type_id: {
          type: 'number',
          description: 'Filter by card type ID (optional)',
        },
        condition: {
          type: 'number',
          description: 'Filter by condition: 1=active/on board (DEFAULT), 2=archived. Only specify if user explicitly asks for archived cards.',
        },
        sort_by: {
          type: 'string',
          description: 'Sort field (default: created). Options: created, updated, title',
        },
        sort_direction: {
          type: 'string',
          description: 'Sort direction (default: desc). Options: asc, desc',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of cards to return. Only specify if user explicitly requests a specific number. Default is 10 (newest cards first).',
        },
        skip: {
          type: 'number',
          description: 'Number of cards to skip for pagination (default 0)',
        },
      },
    },
  },
  {
    name: 'kaiten_get_space_cards',
    description: 'Get cards from a specific space. Returns 10 newest active cards by default.',
    inputSchema: {
      type: 'object',
      properties: {
        space_id: {
          type: 'number',
          description: 'The ID of the space',
        },
        limit: {
          type: 'number',
          description: 'Only specify if user explicitly requests a specific number. Default is 10 newest cards.',
        },
        skip: {
          type: 'number',
          description: 'Number of cards to skip for pagination (default 0)',
        },
        condition: {
          type: 'number',
          description: 'Filter by condition: 1=active/on board (DEFAULT), 2=archived. Only specify if user explicitly asks for archived cards.',
        },
      },
      required: ['space_id'],
    },
  },
  {
    name: 'kaiten_get_board_cards',
    description: 'Get cards from a specific board. Returns 10 newest active cards by default.',
    inputSchema: {
      type: 'object',
      properties: {
        board_id: {
          type: 'number',
          description: 'The ID of the board',
        },
        limit: {
          type: 'number',
          description: 'Only specify if user explicitly requests a specific number. Default is 10 newest cards.',
        },
        skip: {
          type: 'number',
          description: 'Number of cards to skip for pagination (default 0)',
        },
        condition: {
          type: 'number',
          description: 'Filter by condition: 1=active/on board (DEFAULT), 2=archived. Only specify if user explicitly asks for archived cards.',
        },
      },
      required: ['board_id'],
    },
  },
  {
    name: 'kaiten_list_spaces',
    description: 'List all available spaces',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'kaiten_get_space',
    description: 'Get details of a specific space',
    inputSchema: {
      type: 'object',
      properties: {
        space_id: {
          type: 'number',
          description: 'The ID of the space',
        },
      },
      required: ['space_id'],
    },
  },
  {
    name: 'kaiten_list_boards',
    description: 'List all boards, optionally filtered by space',
    inputSchema: {
      type: 'object',
      properties: {
        space_id: {
          type: 'number',
          description: 'Filter by space ID (optional)',
        },
      },
    },
  },
  {
    name: 'kaiten_get_board',
    description: 'Get details of a specific board',
    inputSchema: {
      type: 'object',
      properties: {
        board_id: {
          type: 'number',
          description: 'The ID of the board',
        },
      },
      required: ['board_id'],
    },
  },
  {
    name: 'kaiten_list_columns',
    description: 'List all columns (статусы) for a specific board. Use this to get valid column_id values for creating/moving cards.',
    inputSchema: {
      type: 'object',
      properties: {
        board_id: {
          type: 'number',
          description: 'The ID of the board',
        },
      },
      required: ['board_id'],
    },
  },
  {
    name: 'kaiten_list_lanes',
    description: 'List all lanes (дорожки/swimlanes) for a specific board. Use this to get valid lane_id values for creating/moving cards.',
    inputSchema: {
      type: 'object',
      properties: {
        board_id: {
          type: 'number',
          description: 'The ID of the board',
        },
      },
      required: ['board_id'],
    },
  },
  {
    name: 'kaiten_list_types',
    description: 'List all card types (типы карточек) for a specific board. Use this to get valid type_id values for creating cards.',
    inputSchema: {
      type: 'object',
      properties: {
        board_id: {
          type: 'number',
          description: 'The ID of the board',
        },
      },
      required: ['board_id'],
    },
  },
  {
    name: 'kaiten_get_current_user',
    description: 'Get information about the current authenticated user',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'kaiten_list_users',
    description: 'Search for users by name, email, or username. Use query parameter to filter results.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query to filter users by full_name, email, or username (case-insensitive, partial match)',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of users to return (optional, default: all matching users)',
        },
      },
    },
  },
  {
    name: 'kaiten_cache_invalidate_spaces',
    description: 'Invalidate the spaces cache. Use this when spaces have been created, updated, or deleted outside of this session to force a refresh on the next request.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'kaiten_cache_invalidate_boards',
    description: 'Invalidate the boards cache. Use this when boards have been created, updated, or deleted outside of this session to force a refresh on the next request.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'kaiten_cache_invalidate_users',
    description: 'Invalidate the users cache. Use this when users have been added or updated outside of this session to force a refresh on the next request.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'kaiten_cache_invalidate_all',
    description: 'Invalidate all caches (spaces, boards, users). Use this to force a complete refresh of all cached data.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'kaiten_get_status',
    description: 'Get the current status of the server including cache statistics, queue status, and configuration. Useful for debugging and monitoring.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

// ============================================
// SERVER SETUP
// ============================================

const server = new Server(
  {
    name: 'kaiten-mcp-server',
    version: '2.2.0',
  },
  {
    capabilities: {
      tools: {},
      resources: {
        templates: true,
        subscribe: false,
      },
      prompts: {},
    },
  }
);

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

    const cards = await kaitenClient.getCardsFromSpace(DEFAULT_SPACE_ID, 50);
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
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(simplified, null, 2),
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
        if (validatedArgs.query) searchParams.query = validatedArgs.query;

        // Handle space_id logic
        if (validatedArgs.space_id !== undefined && validatedArgs.space_id !== null && validatedArgs.space_id !== 0) {
          searchParams.space_id = validatedArgs.space_id;
        } else if (validatedArgs.space_id === undefined && DEFAULT_SPACE_ID) {
          searchParams.space_id = DEFAULT_SPACE_ID;
        }

        if (validatedArgs.board_id) searchParams.board_id = validatedArgs.board_id;
        if (validatedArgs.column_id) searchParams.column_id = validatedArgs.column_id;
        if (validatedArgs.lane_id) searchParams.lane_id = validatedArgs.lane_id;
        if (validatedArgs.title) searchParams.title = validatedArgs.title;
        if (validatedArgs.state !== undefined) searchParams.state = validatedArgs.state;
        if (validatedArgs.owner_id) searchParams.owner_id = validatedArgs.owner_id;
        if (validatedArgs.type_id) searchParams.type_id = validatedArgs.type_id;

        searchParams.condition = validatedArgs.condition !== undefined ? validatedArgs.condition : 1;

        if (validatedArgs.sort_by) searchParams.sort_by = validatedArgs.sort_by;
        if (validatedArgs.sort_direction) searchParams.sort_direction = validatedArgs.sort_direction;
        if (validatedArgs.limit) searchParams.limit = validatedArgs.limit;
        if (validatedArgs.skip) searchParams.skip = validatedArgs.skip;

        const cards = await kaitenClient.searchCards(searchParams, signal);
        const simplified = cards.map(simplifyCard);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(simplified, null, 2),
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
        const simplified = cards.map(simplifyCard);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(simplified, null, 2),
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
        const simplified = cards.map(simplifyCard);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(simplified, null, 2),
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
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(simplified, null, 2),
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
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(space, null, 2),
            },
          ],
        };
      }

      case 'kaiten_list_boards': {
        const validatedArgs = ListBoardsSchema.parse(args);

        // Try cache first
        let boards = cache.getBoards(validatedArgs.space_id);
        if (!boards) {
          boards = await kaitenClient.getBoards(validatedArgs.space_id, signal);
          cache.setBoards(boards, validatedArgs.space_id);
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(boards, null, 2),
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
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(board, null, 2),
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

        // Warn if no query provided
        if (!validatedArgs.query) {
          safeLog.warn('[Kaiten MCP] WARNING: kaiten_list_users called without query parameter. This may return a large response.');
        }

        // Try to get from cache (full list)
        let allUsers = cache.getUsers();
        if (!allUsers) {
          allUsers = await kaitenClient.getUsers(undefined, signal);
          cache.setUsers(allUsers);
        }

        // Filter on the cached list if query provided
        let users = allUsers;
        if (validatedArgs.query) {
          const query = validatedArgs.query.toLowerCase();
          users = allUsers.filter(
            (user) =>
              user.full_name?.toLowerCase().includes(query) ||
              user.email?.toLowerCase().includes(query) ||
              user.username?.toLowerCase().includes(query)
          );
        }

        // Apply limit if specified
        if (validatedArgs.limit) {
          users = users.slice(0, validatedArgs.limit);
        }

        const simplified = users.map(simplifyUser);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(simplified, null, 2),
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
          version: '2.2.0',
          config: {
            api_url: config.KAITEN_API_URL,
            default_space_id: config.KAITEN_DEFAULT_SPACE_ID || null,
            max_concurrent_requests: config.KAITEN_MAX_CONCURRENT_REQUESTS,
            cache_ttl_seconds: config.KAITEN_CACHE_TTL_SECONDS,
            request_timeout_ms: config.KAITEN_REQUEST_TIMEOUT_MS,
          },
          cache: cache.getStats(),
          queue: kaitenClient.getQueueStatus(),
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
  console.error('Kaiten MCP Server v2.0 running on stdio');
  console.error('- Tools: 17 available');
  console.error('- Resources: Enabled (cards, spaces, boards)');
  console.error('- Prompts: Server prompt configured');
  console.error('- Validation: Zod schemas active');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
