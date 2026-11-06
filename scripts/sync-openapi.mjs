import fs from 'node:fs';
import path from 'node:path';

const openapiPath = new URL('../openapi/openapi.json', import.meta.url);
const spec = JSON.parse(fs.readFileSync(openapiPath, 'utf8'));

// 1. POST /api/v1/events
spec.paths['/api/v1/events'] = spec.paths['/api/v1/events'] || {};
spec.paths['/api/v1/events'].post = {
  operationId: 'publishEvent',
  tags: ['Gateway'],
  summary: 'Publish an event to the gateway event bus',
  requestBody: {
    required: true,
    content: {
      'application/json': {
        schema: {
          type: 'object',
          properties: {
            type: { type: 'string' },
            data: { type: 'object' }
          },
          required: ['type']
        }
      }
    }
  },
  responses: {
    '200': {
      description: 'Event accepted and broadcast',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' }
            }
          }
        }
      }
    }
  }
};

// 2. PiPoE routes
spec.paths['/api/v1/poe'] = {
  get: {
    operationId: 'listPoePorts',
    tags: ['PoE'],
    summary: 'List PoE switch ports and power status',
    responses: {
      '200': {
        description: 'PoE ports list',
        content: { 'application/json': { schema: { type: 'object' } } }
      }
    }
  }
};

spec.paths['/api/v1/poe/ports/{port}'] = {
  get: {
    operationId: 'getPoePort',
    tags: ['PoE'],
    summary: 'Get details and power status for a PoE port',
    parameters: [{ name: 'port', in: 'path', required: true, schema: { type: 'string' } }],
    responses: {
      '200': {
        description: 'PoE port details',
        content: { 'application/json': { schema: { type: 'object' } } }
      }
    }
  }
};

spec.paths['/api/v1/poe/ports/{port}/power'] = {
  post: {
    operationId: 'setPoePortPower',
    tags: ['PoE'],
    summary: 'Enable or disable power on a PoE port',
    parameters: [{ name: 'port', in: 'path', required: true, schema: { type: 'string' } }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: { enabled: { type: 'boolean' } },
            required: ['enabled']
          }
        }
      }
    },
    responses: {
      '200': {
        description: 'Power state updated',
        content: { 'application/json': { schema: { type: 'object' } } }
      }
    }
  }
};

spec.paths['/api/v1/poe/ports/{port}/cycle'] = {
  post: {
    operationId: 'cyclePoePort',
    tags: ['PoE'],
    summary: 'Power cycle a PoE port (restart connected device)',
    parameters: [{ name: 'port', in: 'path', required: true, schema: { type: 'string' } }],
    requestBody: {
      required: false,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: { offMs: { type: 'number' } }
          }
        }
      }
    },
    responses: {
      '200': {
        description: 'Power cycle started',
        content: { 'application/json': { schema: { type: 'object' } } }
      }
    }
  }
};

// 3. PiStorage routes
spec.paths['/api/v1/storage/status'] = {
  get: {
    operationId: 'getStorageStatus',
    tags: ['Storage'],
    summary: 'Get storage backend and cache status',
    responses: {
      '200': {
        description: 'Storage status',
        content: { 'application/json': { schema: { type: 'object' } } }
      }
    }
  }
};

spec.paths['/api/v1/storage/objects'] = {
  get: {
    operationId: 'listStorageObjects',
    tags: ['Storage'],
    summary: 'List stored objects with optional prefix and limit',
    parameters: [
      { name: 'prefix', in: 'query', required: false, schema: { type: 'string' } },
      { name: 'limit', in: 'query', required: false, schema: { type: 'integer' } }
    ],
    responses: {
      '200': {
        description: 'List of objects',
        content: { 'application/json': { schema: { type: 'object' } } }
      }
    }
  }
};

spec.paths['/api/v1/storage/objects/{key}'] = {
  get: {
    operationId: 'getStorageObject',
    tags: ['Storage'],
    summary: 'Get stored object bytes or metadata',
    parameters: [{ name: 'key', in: 'path', required: true, schema: { type: 'string' } }],
    responses: {
      '200': {
        description: 'Stored object',
        content: { 'application/octet-stream': { schema: { type: 'string' } } }
      }
    }
  },
  put: {
    operationId: 'putStorageObject',
    tags: ['Storage'],
    summary: 'Store or upload an object',
    parameters: [{ name: 'key', in: 'path', required: true, schema: { type: 'string' } }],
    requestBody: {
      required: true,
      content: { 'application/octet-stream': { schema: { type: 'string' } } }
    },
    responses: {
      '200': {
        description: 'Object saved',
        content: { 'application/json': { schema: { type: 'object' } } }
      }
    }
  },
  delete: {
    operationId: 'deleteStorageObject',
    tags: ['Storage'],
    summary: 'Delete a stored object',
    parameters: [{ name: 'key', in: 'path', required: true, schema: { type: 'string' } }],
    responses: {
      '200': {
        description: 'Object deleted',
        content: { 'application/json': { schema: { type: 'object' } } }
      }
    }
  }
};

spec.paths['/api/v1/storage/signed-urls'] = {
  post: {
    operationId: 'createStorageSignedUrl',
    tags: ['Storage'],
    summary: 'Generate a presigned upload or download URL',
    requestBody: {
      required: true,
      content: { 'application/json': { schema: { type: 'object' } } }
    },
    responses: {
      '200': {
        description: 'Signed URL result',
        content: { 'application/json': { schema: { type: 'object' } } }
      }
    }
  }
};

spec.paths['/api/v1/storage/use-at'] = {
  post: {
    operationId: 'setStorageUseAt',
    tags: ['Storage'],
    summary: 'Schedule prefetching of storage object for future use',
    requestBody: {
      required: true,
      content: { 'application/json': { schema: { type: 'object' } } }
    },
    responses: {
      '200': {
        description: 'Use-at scheduled',
        content: { 'application/json': { schema: { type: 'object' } } }
      }
    }
  }
};

spec.paths['/api/v1/storage/spool/flush'] = {
  post: {
    operationId: 'flushStorageSpool',
    tags: ['Storage'],
    summary: 'Flush offline pending spool uploads to backend storage',
    responses: {
      '200': {
        description: 'Spool flushed',
        content: { 'application/json': { schema: { type: 'object' } } }
      }
    }
  }
};

spec.paths['/api/v1/storage/cache/prune'] = {
  post: {
    operationId: 'pruneStorageCache',
    tags: ['Storage'],
    summary: 'Prune cached local storage objects',
    responses: {
      '200': {
        description: 'Cache pruned',
        content: { 'application/json': { schema: { type: 'object' } } }
      }
    }
  }
};

// 4. PiAgent routes
spec.paths['/api/v1/agents'] = {
  get: {
    operationId: 'listAgents',
    tags: ['Agent'],
    summary: 'List active and registered agents',
    responses: {
      '200': {
        description: 'Agents list',
        content: { 'application/json': { schema: { type: 'array', items: { type: 'object' } } } }
      }
    }
  },
  post: {
    operationId: 'createAgent',
    tags: ['Agent'],
    summary: 'Create or launch a new agent instance',
    requestBody: {
      required: true,
      content: { 'application/json': { schema: { type: 'object' } } }
    },
    responses: {
      '200': {
        description: 'Agent created',
        content: { 'application/json': { schema: { type: 'object' } } }
      }
    }
  }
};

spec.paths['/api/v1/agents/{id}'] = {
  get: {
    operationId: 'getAgent',
    tags: ['Agent'],
    summary: 'Get status and details of an agent',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
    responses: {
      '200': {
        description: 'Agent details',
        content: { 'application/json': { schema: { type: 'object' } } }
      }
    }
  },
  delete: {
    operationId: 'deleteAgent',
    tags: ['Agent'],
    summary: 'Terminate and unregister an agent',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
    responses: {
      '200': {
        description: 'Agent terminated',
        content: { 'application/json': { schema: { type: 'object' } } }
      }
    }
  }
};

spec.paths['/api/v1/agents/{id}/stop'] = {
  post: {
    operationId: 'stopAgent',
    tags: ['Agent'],
    summary: 'Stop an active agent execution',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
    responses: {
      '200': {
        description: 'Agent stopped',
        content: { 'application/json': { schema: { type: 'object' } } }
      }
    }
  }
};

spec.paths['/api/v1/agent/interrupt'] = {
  post: {
    operationId: 'interruptAgent',
    tags: ['Agent'],
    summary: 'Send an interrupt signal to agents',
    requestBody: {
      required: false,
      content: { 'application/json': { schema: { type: 'object' } } }
    },
    responses: {
      '200': {
        description: 'Interrupt sent',
        content: { 'application/json': { schema: { type: 'object' } } }
      }
    }
  }
};

spec.paths['/api/v1/chat'] = {
  post: {
    operationId: 'agentChat',
    tags: ['Agent'],
    summary: 'Chat interaction with an agent',
    requestBody: {
      required: true,
      content: { 'application/json': { schema: { type: 'object' } } }
    },
    responses: {
      '200': {
        description: 'Chat reply',
        content: { 'application/json': { schema: { type: 'object' } } }
      }
    }
  }
};

spec.paths['/api/v1/messages'] = {
  post: {
    operationId: 'sendAgentMessage',
    tags: ['Agent'],
    summary: 'Send a message between agents',
    requestBody: {
      required: true,
      content: { 'application/json': { schema: { type: 'object' } } }
    },
    responses: {
      '200': {
        description: 'Message sent',
        content: { 'application/json': { schema: { type: 'object' } } }
      }
    }
  }
};

spec.paths['/api/v1/messages/inbox/{agentId}'] = {
  get: {
    operationId: 'getAgentInbox',
    tags: ['Agent'],
    summary: 'Get message inbox for an agent',
    parameters: [{ name: 'agentId', in: 'path', required: true, schema: { type: 'string' } }],
    responses: {
      '200': {
        description: 'Messages inbox',
        content: { 'application/json': { schema: { type: 'array', items: { type: 'object' } } } }
      }
    }
  }
};

spec.paths['/api/v1/messages/ack'] = {
  post: {
    operationId: 'ackAgentMessage',
    tags: ['Agent'],
    summary: 'Acknowledge processed agent messages',
    requestBody: {
      required: true,
      content: { 'application/json': { schema: { type: 'object' } } }
    },
    responses: {
      '200': {
        description: 'Acknowledged',
        content: { 'application/json': { schema: { type: 'object' } } }
      }
    }
  }
};

spec.paths['/api/v1/messages/broadcast'] = {
  post: {
    operationId: 'broadcastAgentMessage',
    tags: ['Agent'],
    summary: 'Broadcast a message to all agents',
    requestBody: {
      required: true,
      content: { 'application/json': { schema: { type: 'object' } } }
    },
    responses: {
      '200': {
        description: 'Broadcast delivered',
        content: { 'application/json': { schema: { type: 'object' } } }
      }
    }
  }
};

spec.paths['/api/v1/models'] = {
  get: {
    operationId: 'listAgentModels',
    tags: ['Agent'],
    summary: 'List available local LLM models',
    responses: {
      '200': {
        description: 'Available models',
        content: { 'application/json': { schema: { type: 'array', items: { type: 'object' } } } }
      }
    }
  }
};

// 5. PiNotify routes
spec.paths['/api/v1/notify'] = {
  post: {
    operationId: 'sendNotification',
    tags: ['Notify'],
    summary: 'Send an email or SMS notification',
    requestBody: {
      required: true,
      content: { 'application/json': { schema: { type: 'object' } } }
    },
    responses: {
      '200': {
        description: 'Notification dispatched',
        content: { 'application/json': { schema: { type: 'object' } } }
      }
    }
  }
};

spec.paths['/api/v1/notify/contacts'] = {
  get: {
    operationId: 'listNotifyContacts',
    tags: ['Notify'],
    summary: 'List saved notification recipient contacts',
    responses: {
      '200': {
        description: 'Contacts list',
        content: { 'application/json': { schema: { type: 'array', items: { type: 'object' } } } }
      }
    }
  },
  post: {
    operationId: 'createNotifyContact',
    tags: ['Notify'],
    summary: 'Create a new recipient contact',
    requestBody: {
      required: true,
      content: { 'application/json': { schema: { type: 'object' } } }
    },
    responses: {
      '200': {
        description: 'Contact created',
        content: { 'application/json': { schema: { type: 'object' } } }
      }
    }
  }
};

spec.paths['/api/v1/notify/contacts/{slug}'] = {
  get: {
    operationId: 'getNotifyContact',
    tags: ['Notify'],
    summary: 'Get details for a recipient contact',
    parameters: [{ name: 'slug', in: 'path', required: true, schema: { type: 'string' } }],
    responses: {
      '200': {
        description: 'Contact details',
        content: { 'application/json': { schema: { type: 'object' } } }
      }
    }
  },
  put: {
    operationId: 'updateNotifyContact',
    tags: ['Notify'],
    summary: 'Update details for a recipient contact',
    parameters: [{ name: 'slug', in: 'path', required: true, schema: { type: 'string' } }],
    requestBody: {
      required: true,
      content: { 'application/json': { schema: { type: 'object' } } }
    },
    responses: {
      '200': {
        description: 'Contact updated',
        content: { 'application/json': { schema: { type: 'object' } } }
      }
    }
  },
  delete: {
    operationId: 'deleteNotifyContact',
    tags: ['Notify'],
    summary: 'Delete a recipient contact',
    parameters: [{ name: 'slug', in: 'path', required: true, schema: { type: 'string' } }],
    responses: {
      '200': {
        description: 'Contact deleted',
        content: { 'application/json': { schema: { type: 'object' } } }
      }
    }
  }
};

spec.paths['/api/v1/notify/provider'] = {
  get: {
    operationId: 'getNotifyProvider',
    tags: ['Notify'],
    summary: 'Get notification provider configuration status',
    responses: {
      '200': {
        description: 'Provider status',
        content: { 'application/json': { schema: { type: 'object' } } }
      }
    }
  },
  put: {
    operationId: 'updateNotifyProvider',
    tags: ['Notify'],
    summary: 'Configure email/SMS provider credentials',
    requestBody: {
      required: true,
      content: { 'application/json': { schema: { type: 'object' } } }
    },
    responses: {
      '200': {
        description: 'Provider configured',
        content: { 'application/json': { schema: { type: 'object' } } }
      }
    }
  },
  delete: {
    operationId: 'deleteNotifyProvider',
    tags: ['Notify'],
    summary: 'Clear notification provider credentials',
    responses: {
      '200': {
        description: 'Provider cleared',
        content: { 'application/json': { schema: { type: 'object' } } }
      }
    }
  }
};

spec.paths['/api/v1/notify/log'] = {
  get: {
    operationId: 'getNotifyLog',
    tags: ['Notify'],
    summary: 'Get recent notification dispatch log',
    parameters: [{ name: 'limit', in: 'query', required: false, schema: { type: 'integer' } }],
    responses: {
      '200': {
        description: 'Dispatch log',
        content: { 'application/json': { schema: { type: 'array', items: { type: 'object' } } } }
      }
    }
  }
};

spec.paths['/api/v1/notify/outbox'] = {
  get: {
    operationId: 'getNotifyOutbox',
    tags: ['Notify'],
    summary: 'Get simulation notification outbox',
    responses: {
      '200': {
        description: 'Simulation outbox',
        content: { 'application/json': { schema: { type: 'array', items: { type: 'object' } } } }
      }
    }
  }
};

// 6. PiPerception routes
spec.paths['/api/v1/perception/streams'] = {
  get: {
    operationId: 'listPerceptionStreams',
    tags: ['Perception'],
    summary: 'List configured computer vision video streams',
    responses: {
      '200': {
        description: 'Camera streams',
        content: { 'application/json': { schema: { type: 'array', items: { type: 'object' } } } }
      }
    }
  },
  post: {
    operationId: 'addPerceptionStream',
    tags: ['Perception'],
    summary: 'Configure a camera stream for perception tracking',
    requestBody: {
      required: true,
      content: { 'application/json': { schema: { type: 'object' } } }
    },
    responses: {
      '200': {
        description: 'Stream configured',
        content: { 'application/json': { schema: { type: 'object' } } }
      }
    }
  }
};

spec.paths['/api/v1/perception/streams/{cameraId}/start'] = {
  post: {
    operationId: 'startPerceptionStream',
    tags: ['Perception'],
    summary: 'Start real-time detection on a camera stream',
    parameters: [{ name: 'cameraId', in: 'path', required: true, schema: { type: 'string' } }],
    responses: {
      '200': {
        description: 'Stream started',
        content: { 'application/json': { schema: { type: 'object' } } }
      }
    }
  }
};

spec.paths['/api/v1/perception/streams/{cameraId}/stop'] = {
  post: {
    operationId: 'stopPerceptionStream',
    tags: ['Perception'],
    summary: 'Stop real-time detection on a camera stream',
    parameters: [{ name: 'cameraId', in: 'path', required: true, schema: { type: 'string' } }],
    responses: {
      '200': {
        description: 'Stream stopped',
        content: { 'application/json': { schema: { type: 'object' } } }
      }
    }
  }
};

spec.paths['/api/v1/perception/streams/{cameraId}/path'] = {
  post: {
    operationId: 'setPerceptionStreamPath',
    tags: ['Perception'],
    summary: 'Set simulation motion path for a camera stream',
    parameters: [{ name: 'cameraId', in: 'path', required: true, schema: { type: 'string' } }],
    requestBody: {
      required: true,
      content: { 'application/json': { schema: { type: 'object' } } }
    },
    responses: {
      '200': {
        description: 'Path updated',
        content: { 'application/json': { schema: { type: 'object' } } }
      }
    }
  }
};

spec.paths['/api/v1/perception/tracks'] = {
  get: {
    operationId: 'getPerceptionTracks',
    tags: ['Perception'],
    summary: 'Get active tracked 2D subjects across all cameras',
    responses: {
      '200': {
        description: 'Active tracks by camera',
        content: { 'application/json': { schema: { type: 'object' } } }
      }
    }
  }
};

spec.paths['/api/v1/perception/pusher'] = {
  get: {
    operationId: 'getPerceptionPusher',
    tags: ['Perception'],
    summary: 'Get PiSpace pusher status and telemetry',
    responses: {
      '200': {
        description: 'Pusher status',
        content: { 'application/json': { schema: { type: 'object' } } }
      }
    }
  }
};

spec.paths['/api/v1/perception/events'] = {
  post: {
    operationId: 'postPerceptionEvent',
    tags: ['Perception'],
    summary: 'Post 2D detections into gateway perception event bus',
    requestBody: {
      required: true,
      content: { 'application/json': { schema: { type: 'object' } } }
    },
    responses: {
      '200': {
        description: 'Event accepted',
        content: { 'application/json': { schema: { type: 'object' } } }
      }
    }
  }
};

// 7. PiSpace routes
spec.paths['/api/v1/spatial/venue'] = {
  get: {
    operationId: 'getSpatialVenue',
    tags: ['Spatial'],
    summary: 'Get 3D architectural venue geometry, dimensions and camera positions',
    responses: {
      '200': {
        description: 'Venue geometry model',
        content: { 'application/json': { schema: { type: 'object' } } }
      }
    }
  }
};

spec.paths['/api/v1/spatial/zones'] = {
  get: {
    operationId: 'listSpatialZones',
    tags: ['Spatial'],
    summary: 'List defined 3D liturgical stage zones (altar, pulpit, lectern, etc.)',
    responses: {
      '200': {
        description: 'Stage zones list',
        content: { 'application/json': { schema: { type: 'array', items: { type: 'object' } } } }
      }
    }
  }
};

spec.paths['/api/v1/spatial/zones/{zoneId}'] = {
  get: {
    operationId: 'getSpatialZone',
    tags: ['Spatial'],
    summary: 'Get details and 3D polygon target for a specific zone',
    parameters: [{ name: 'zoneId', in: 'path', required: true, schema: { type: 'string' } }],
    responses: {
      '200': {
        description: 'Zone details',
        content: { 'application/json': { schema: { type: 'object' } } }
      }
    }
  }
};

spec.paths['/api/v1/spatial/occluders'] = {
  get: {
    operationId: 'listSpatialOccluders',
    tags: ['Spatial'],
    summary: 'List 3D occluders for AR broadcast graphic keymasking',
    responses: {
      '200': {
        description: '3D occluders list',
        content: { 'application/json': { schema: { type: 'array', items: { type: 'object' } } } }
      }
    }
  }
};

spec.paths['/api/v1/spatial/occluders/{id}'] = {
  get: {
    operationId: 'getSpatialOccluder',
    tags: ['Spatial'],
    summary: 'Get specific 3D occluder geometry',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
    responses: {
      '200': {
        description: 'Occluder geometry',
        content: { 'application/json': { schema: { type: 'object' } } }
      }
    }
  }
};

spec.paths['/api/v1/spatial/solve-ptz'] = {
  post: {
    operationId: 'solveSpatialPtz',
    tags: ['Spatial'],
    summary: 'Inverse solver: calculate PTZ angles to frame a 3D point or liturgical zone',
    requestBody: {
      required: true,
      content: { 'application/json': { schema: { type: 'object' } } }
    },
    responses: {
      '200': {
        description: 'Solved PTZ solution',
        content: { 'application/json': { schema: { type: 'object' } } }
      }
    }
  }
};

spec.paths['/api/v1/spatial/project'] = {
  post: {
    operationId: 'projectSpatialPoint',
    tags: ['Spatial'],
    summary: 'Project 2D camera bounding box into 3D world coordinates on stage plane',
    requestBody: {
      required: true,
      content: { 'application/json': { schema: { type: 'object' } } }
    },
    responses: {
      '200': {
        description: '3D world position and matched zone',
        content: { 'application/json': { schema: { type: 'object' } } }
      }
    }
  }
};

spec.paths['/api/v1/spatial/triangulate'] = {
  post: {
    operationId: 'triangulateSpatialCameras',
    tags: ['Spatial'],
    summary: 'Triangulate rays from 2 cameras to solve absolute 3D position in venue',
    requestBody: {
      required: true,
      content: { 'application/json': { schema: { type: 'object' } } }
    },
    responses: {
      '200': {
        description: 'Triangulation intersection result',
        content: { 'application/json': { schema: { type: 'object' } } }
      }
    }
  }
};

// Sort paths alphabetically
const sortedPaths = {};
for (const k of Object.keys(spec.paths).sort()) {
  sortedPaths[k] = spec.paths[k];
}
spec.paths = sortedPaths;

fs.writeFileSync(openapiPath, JSON.stringify(spec, null, 2) + '\n', 'utf8');
console.log('OpenAPI synced successfully. Total paths:', Object.keys(spec.paths).length);
