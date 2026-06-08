const swaggerUi = require('swagger-ui-express');

const authScheme = {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT'
};

function pathItem(summary, tag, options = {}) {
    const item = {
        summary,
        tags: [tag],
        responses: options.responses || { 200: { description: 'Success' } }
    };

    if (options.security !== false) {
        item.security = [{ bearerAuth: [] }];
    }

    if (options.parameters) {
        item.parameters = options.parameters;
    }

    if (options.requestBody) {
        item.requestBody = options.requestBody;
    }

    return item;
}

const mainApiSpec = {
    openapi: '3.0.3',
    info: {
        title: 'Lexy API',
        version: '1.0.0',
        description: 'Основной API приложения Lexy.'
    },
    servers: [{ url: '/' }],
    tags: [
        { name: 'General' },
        { name: 'Auth' },
        { name: 'Decks' },
        { name: 'Cards' },
        { name: 'Public Decks' },
        { name: 'Notifications' },
        { name: 'Dictionary' },
        { name: 'Activity' },
        { name: 'Sync' },
        { name: 'Admin' },
        { name: 'Internal' }
    ],
    components: {
        securitySchemes: {
            bearerAuth: authScheme
        }
    },
    paths: {
        '/': {
            get: pathItem('Health check for the main app', 'General', {
                security: false,
                responses: { 200: { description: 'Main app is running' } }
            })
        },
        '/api/notifications/public-key': {
            get: pathItem('Get VAPID public key', 'Notifications', {
                security: false,
                responses: { 200: { description: 'Public key' } }
            })
        },
        '/api/dictionary/translate': {
            get: pathItem('Translate a word', 'Dictionary', {
                security: false,
                parameters: [{ name: 'text', in: 'query', required: true, schema: { type: 'string' } }],
                responses: { 200: { description: 'Translation result' } }
            })
        },
        '/api/notifications/subscribe': {
            post: pathItem('Subscribe to push notifications', 'Notifications', {
                responses: { 200: { description: 'Subscribed' } }
            })
        },
        '/api/notifications/test': {
            post: pathItem('Send a test push notification', 'Notifications', {
                responses: { 200: { description: 'Notification sent' } }
            })
        },
        '/api/auth/register': {
            post: pathItem('Create a new account', 'Auth', {
                security: false,
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                required: ['username', 'password', 'name'],
                                properties: {
                                    username: { type: 'string' },
                                    password: { type: 'string' },
                                    name: { type: 'string' }
                                }
                            }
                        }
                    }
                },
                responses: { 201: { description: 'User created' } }
            })
        },
        '/api/auth/login': {
            post: pathItem('Login and receive a JWT token', 'Auth', {
                security: false,
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                required: ['username', 'password'],
                                properties: {
                                    username: { type: 'string' },
                                    password: { type: 'string' }
                                }
                            }
                        }
                    }
                },
                responses: { 200: { description: 'Authentication successful' } }
            })
        },
        '/api/auth/me': {
            get: pathItem('Get the current user', 'Auth')
        },
        '/api/auth/profile': {
            put: pathItem('Update the current profile', 'Auth')
        },
        '/api/auth/stats': {
            get: pathItem('Get current user statistics', 'Auth'),
            put: pathItem('Update current user statistics', 'Auth')
        },
        '/api/auth/password': {
            put: pathItem('Change the current password', 'Auth')
        },
        '/api/auth/account': {
            delete: pathItem('Delete the current account', 'Auth')
        },
        '/api/activity': {
            get: pathItem('Get study activity', 'Activity'),
            post: pathItem('Record study activity', 'Activity', {
                responses: { 201: { description: 'Activity saved' } }
            })
        },
        '/api/sync': {
            get: pathItem('Download sync state', 'Sync'),
            put: pathItem('Upload sync state', 'Sync')
        },
        '/api/decks': {
            get: pathItem('List user decks', 'Decks'),
            post: pathItem('Create a deck', 'Decks', {
                responses: { 201: { description: 'Deck created' } }
            })
        },
        '/api/decks/{id}/submit': {
            post: pathItem('Submit a deck for review', 'Decks', {
                parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }]
            })
        },
        '/api/decks/{id}': {
            get: pathItem('Get deck details', 'Decks', {
                parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }]
            }),
            put: pathItem('Update a deck', 'Decks', {
                parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }]
            }),
            delete: pathItem('Delete a deck', 'Decks', {
                parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }]
            })
        },
        '/api/decks/{id}/add': {
            post: pathItem('Add a card to a deck by content', 'Decks', {
                parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }]
            })
        },
        '/api/decks/{id}/image': {
            get: pathItem('Get deck image', 'Decks', {
                security: false,
                parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }]
            }),
            post: pathItem('Upload a deck image', 'Decks', {
                parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }]
            })
        },
        '/api/decks/{id}/cards': {
            get: pathItem('Get cards in a deck', 'Decks', {
                parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }]
            }),
            post: pathItem('Create a card in a deck', 'Decks', {
                parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
                responses: { 201: { description: 'Card created' } }
            })
        },
        '/api/cards/{id}/favorite': {
            put: pathItem('Mark card as favorite', 'Cards', {
                parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }]
            })
        },
        '/api/cards/favorites': {
            get: pathItem('List favorite cards', 'Cards')
        },
        '/api/cards/{id}/forgotten': {
            put: pathItem('Mark card as forgotten', 'Cards', {
                parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }]
            })
        },
        '/api/cards/forgotten': {
            get: pathItem('List forgotten cards', 'Cards')
        },
        '/api/cards/{id}': {
            put: pathItem('Update a card', 'Cards', {
                parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }]
            }),
            delete: pathItem('Delete a card', 'Cards', {
                parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }]
            })
        },
        '/api/internal/users/search': {
            get: pathItem('Search users for internal features', 'Internal')
        },
        '/api/admin/submissions': {
            get: pathItem('List deck submissions for moderation', 'Admin')
        },
        '/api/admin/users': {
            get: pathItem('List users', 'Admin')
        },
        '/api/admin/users/{id}/ban': {
            put: pathItem('Ban a user', 'Admin', {
                parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }]
            })
        },
        '/api/admin/users/{id}/role': {
            put: pathItem('Update a user role', 'Admin', {
                parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }]
            })
        },
        '/api/admin/submissions/{id}': {
            put: pathItem('Review a submission', 'Admin', {
                parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }]
            })
        },
        '/api/admin/public-decks': {
            get: pathItem('List public decks for admin', 'Admin'),
            post: pathItem('Create a public deck', 'Admin', {
                responses: { 201: { description: 'Public deck created' } }
            })
        },
        '/api/admin/public-decks/{id}': {
            put: pathItem('Update a public deck', 'Admin', {
                parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }]
            }),
            delete: pathItem('Delete a public deck', 'Admin', {
                parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }]
            })
        },
        '/api/admin/public-decks/{id}/image': {
            post: pathItem('Upload an image for a public deck', 'Admin', {
                parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }]
            })
        },
        '/api/admin/public-decks/{id}/cards': {
            get: pathItem('List cards in an admin public deck', 'Admin', {
                parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }]
            }),
            post: pathItem('Create a card in a public deck', 'Admin', {
                parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
                responses: { 201: { description: 'Public deck card created' } }
            })
        },
        '/api/admin/public-cards/{id}': {
            delete: pathItem('Delete a public card', 'Admin', {
                parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }]
            })
        },
        '/api/public-decks': {
            get: pathItem('List public decks', 'Public Decks', {
                security: false
            })
        },
        '/api/public-decks/{id}/cards': {
            get: pathItem('List cards in a public deck', 'Public Decks', {
                security: false,
                parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }]
            })
        }
    }
};

const multiplayerApiSpec = {
    openapi: '3.0.3',
    info: {
        title: 'Lexy Multiplayer API',
        version: '1.0.0',
        description: 'API микросервиса мультиплеера Lexy.'
    },
    servers: [{ url: '/' }],
    tags: [
        { name: 'Health' },
        { name: 'Overview' },
        { name: 'Sessions' },
        { name: 'Invites' },
        { name: 'Leaderboard' },
        { name: 'History' }
    ],
    components: {
        securitySchemes: {
            bearerAuth: authScheme
        }
    },
    paths: {
        '/api/health': {
            get: pathItem('Health check for the multiplayer service', 'Health', {
                security: false,
                responses: { 200: { description: 'Service is running' } }
            })
        },
        '/api/multiplayer/overview': {
            get: pathItem('Get multiplayer overview', 'Overview')
        },
        '/api/multiplayer/invites': {
            get: pathItem('List incoming invites', 'Invites')
        },
        '/api/multiplayer/sessions': {
            post: pathItem('Create a multiplayer session', 'Sessions', {
                responses: { 201: { description: 'Session created' } }
            })
        },
        '/api/multiplayer/sessions/join': {
            post: pathItem('Join a multiplayer session', 'Sessions')
        },
        '/api/multiplayer/sessions/{id}': {
            get: pathItem('Get a session by id', 'Sessions', {
                parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }]
            }),
            delete: pathItem('Delete a session', 'Sessions', {
                parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }]
            })
        },
        '/api/multiplayer/sessions/{id}/invites': {
            post: pathItem('Invite users to a session', 'Sessions', {
                parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }]
            })
        },
        '/api/multiplayer/invites/{id}/respond': {
            post: pathItem('Respond to an invite', 'Invites', {
                parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }]
            })
        },
        '/api/multiplayer/sessions/{id}/start': {
            post: pathItem('Start a session', 'Sessions', {
                parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }]
            })
        },
        '/api/multiplayer/sessions/{id}/answer': {
            post: pathItem('Submit an answer in a session', 'Sessions', {
                parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }]
            })
        },
        '/api/multiplayer/leaderboard': {
            get: pathItem('Get the leaderboard', 'Leaderboard')
        },
        '/api/multiplayer/history': {
            get: pathItem('Get multiplayer history', 'History')
        }
    }
};

function mountSwagger(app, routePath, spec) {
    app.use(routePath, swaggerUi.serve, swaggerUi.setup(spec, {
        explorer: true,
        customSiteTitle: spec.info.title
    }));
}

module.exports = {
    mainApiSpec,
    multiplayerApiSpec,
    mountSwagger
};