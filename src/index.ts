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
    description: 'Get card by ID with full details',
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
    name: 'kaiten_create_card',
    description: 'Create new card',
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
    description: 'Update card fields',
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
    description: 'Delete card',
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
    description: 'Get card comments',
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
    description: 'Add comment to card',
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
    description: 'Update comment',
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
    description: 'Search cards with filters. Default: default space, limit=10, active cards, newest first',
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
      },
    },
  },
  {
    name: 'kaiten_get_space_cards',
    description: 'Get space cards (default: 10 newest active)',
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
      },
      required: ['space_id'],
    },
  },
  {
    name: 'kaiten_get_board_cards',
    description: 'Get board cards (default: 10 newest active)',
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
      },
      required: ['board_id'],
    },
  },
  {
    name: 'kaiten_list_spaces',
    description: 'List all spaces',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'kaiten_get_space',
    description: 'Get space details',
    inputSchema: {
      type: 'object',
      properties: {
        space_id: {
          type: 'number',
          description: 'Space ID',
        },
      },
      required: ['space_id'],
    },
  },
  {
    name: 'kaiten_list_boards',
    description: 'List boards (optionally filtered by space)',
    inputSchema: {
      type: 'object',
      properties: {
        space_id: {
          type: 'number',
          description: 'Space ID filter',
        },
      },
    },
  },
  {
    name: 'kaiten_get_board',
    description: 'Get board details',
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
    name: 'kaiten_list_columns',
    description: 'List board columns (for column_id)',
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
    description: 'List board lanes/swimlanes (for lane_id)',
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
    description: 'List card types (for type_id)',
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
    description: 'Get current authenticated user',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'kaiten_list_users',
    description: 'Search users (IMPORTANT: use Latin names only)',
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

        // Human-readable format
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

        // Use compact format for search to save context - full details available via kaiten_get_card
        const simplified = cards.map(simplifyCardCompact);

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
        summary += ':\n\n';

        // Format each card nicely
        simplified.forEach((card, index) => {
          summary += `${index + 1}. ${card.title}\n`;
          summary += `   📋 Board: ${card.board_title || 'N/A'}\n`;
          summary += `   👤 Owner: ${card.owner_name || 'Unassigned'}\n`;
          if (card.asap) summary += `   ⚡ ASAP\n`;
          if (card.blocked) summary += `   🚫 BLOCKED\n`;
          summary += `   🔗 ${card.url}\n`;
          summary += `   🕐 Updated: ${card.updated || 'N/A'}\n\n`;
        });

        summary += `\nℹ️ Use kaiten_get_card with card ID for full details.`;

        return {
          content: [
            {
              type: 'text' as const,
              text: summary,
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
        const simplified = cards.map(simplifyCardCompact);

        // Human-readable format (similar to search)
        let output = `Found ${cards.length} card(s) in space ${validatedArgs.space_id}:\n\n`;
        simplified.forEach((card, index) => {
          output += `${index + 1}. ${card.title}\n`;
          output += `   📋 Board: ${card.board_title || 'N/A'}\n`;
          output += `   👤 Owner: ${card.owner_name || 'Unassigned'}\n`;
          if (card.asap) output += `   ⚡ ASAP\n`;
          if (card.blocked) output += `   🚫 BLOCKED\n`;
          output += `   🔗 ${card.url}\n`;
          output += `   🕐 Updated: ${card.updated || 'N/A'}\n\n`;
        });
        output += `\nℹ️ Use kaiten_get_card for full details.`;

        return {
          content: [
            {
              type: 'text' as const,
              text: output,
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
        const simplified = cards.map(simplifyCardCompact);

        // Human-readable format (similar to search)
        let output = `Found ${cards.length} card(s) on board ${validatedArgs.board_id}:\n\n`;
        simplified.forEach((card, index) => {
          output += `${index + 1}. ${card.title}\n`;
          output += `   📋 Board: ${card.board_title || 'N/A'}\n`;
          output += `   👤 Owner: ${card.owner_name || 'Unassigned'}\n`;
          if (card.asap) output += `   ⚡ ASAP\n`;
          if (card.blocked) output += `   🚫 BLOCKED\n`;
          output += `   🔗 ${card.url}\n`;
          output += `   🕐 Updated: ${card.updated || 'N/A'}\n\n`;
        });
        output += `\nℹ️ Use kaiten_get_card for full details.`;

        return {
          content: [
            {
              type: 'text' as const,
              text: output,
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

        // Use server-side filtering when parameters provided
        // /users endpoint supports query, limit, and offset for server-side filtering
        if (validatedArgs.query || validatedArgs.limit || validatedArgs.offset) {
          const users = await kaitenClient.getUsers({
            query: validatedArgs.query,
            limit: validatedArgs.limit,
            offset: validatedArgs.offset,
          }, signal);

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

        // Fallback: cache full list when no parameters
        // Note: Starting mid-July, /users endpoint returns max 100 users per request
        safeLog.warn('[Kaiten MCP] WARNING: kaiten_list_users called without parameters. Consider using query parameter for better performance.');

        let allUsers = cache.getUsers();
        if (!allUsers) {
          allUsers = await kaitenClient.getUsers(undefined, signal);
          cache.setUsers(allUsers);
        }

        const simplified = allUsers.map(simplifyUser);
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
