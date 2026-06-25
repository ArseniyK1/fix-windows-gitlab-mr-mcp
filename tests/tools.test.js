import { jest } from '@jest/globals';

// Set env vars before importing the module
process.env.MR_MCP_GITLAB_TOKEN = 'mock-token';
process.env.MR_MCP_GITLAB_HOST = 'https://gitlab.example.com';

const mockGitlabInstance = {
    Projects: {
        all: jest.fn(),
    },
    MergeRequests: {
        all: jest.fn(),
        show: jest.fn(),
        allDiffs: jest.fn(),
        showChanges: jest.fn(),
        edit: jest.fn(),
    },
    MergeRequestDiscussions: {
        all: jest.fn(),
        create: jest.fn(),
        resolve: jest.fn(),
    },
    MergeRequestApprovals: {
        approve: jest.fn(),
        unapprove: jest.fn(),
    },
    Issues: {
        show: jest.fn(),
    },
};

// Mock the Gitlab library
jest.unstable_mockModule('@gitbeaker/rest', () => ({
    Gitlab: jest.fn(() => mockGitlabInstance),
}));

// Mock the MCP SDK
const registeredTools = new Map();
const mockMcpServerInstance = {
    tool: jest.fn((name, description, schema, handler) => {
        registeredTools.set(name, handler);
    }),
    connect: jest.fn(),
};

jest.unstable_mockModule('@modelcontextprotocol/sdk/server/mcp.js', () => ({
    McpServer: jest.fn(() => mockMcpServerInstance),
}));

jest.unstable_mockModule('@modelcontextprotocol/sdk/server/stdio.js', () => ({
    StdioServerTransport: jest.fn(),
}));

// Import the module under test
await import('../index.js');

describe('GitLab MR MCP Tools', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    const getToolHandler = (name) => {
        const handler = registeredTools.get(name);
        if (!handler) {
            throw new Error(`Tool ${name} not found. Available tools: ${Array.from(registeredTools.keys()).join(', ')}`);
        }
        return handler;
    };

    describe('get_projects', () => {
        it('should return a list of projects', async () => {
            const mockProjects = [
                {
                    id: 1,
                    description: 'Test Project',
                    name: 'test-project',
                    path: 'test/project',
                    path_with_namespace: 'group/test-project',
                    web_url: 'https://gitlab.com/group/test-project',
                    default_branch: 'main',
                },
            ];
            mockGitlabInstance.Projects.all.mockResolvedValue(mockProjects);

            const handler = getToolHandler('get_projects');
            const result = await handler({ verbose: false });

            expect(mockGitlabInstance.Projects.all).toHaveBeenCalled();
            const content = JSON.parse(result.content[0].text);
            expect(content).toHaveLength(1);
            expect(content[0].id).toBe(1);
        });

        it('should return raw projects if verbose is true', async () => {
            const mockProjects = [{ id: 1, extra_field: 'hidden' }];
            mockGitlabInstance.Projects.all.mockResolvedValue(mockProjects);

            const handler = getToolHandler('get_projects');
            const result = await handler({ verbose: true });

            const content = JSON.parse(result.content[0].text);
            expect(content[0].extra_field).toBe('hidden');
        });
    });

    describe('list_open_merge_requests', () => {
        it('should return open merge requests', async () => {
            const mockMrs = [
                {
                    iid: 1,
                    project_id: 123,
                    title: 'Test MR',
                    description: 'Description',
                    state: 'opened',
                    web_url: 'http://url',
                },
            ];
            mockGitlabInstance.MergeRequests.all.mockResolvedValue(mockMrs);

            const handler = getToolHandler('list_open_merge_requests');
            const result = await handler({ project_id: 123, verbose: false });

            expect(mockGitlabInstance.MergeRequests.all).toHaveBeenCalledWith({ projectId: 123, state: 'opened' });
            const content = JSON.parse(result.content[0].text);
            expect(content).toHaveLength(1);
            expect(content[0].title).toBe('Test MR');
        });
    });

    describe('get_merge_request_details', () => {
        it('should return merge request details', async () => {
            const mockMr = {
                title: 'MR Title',
                description: 'Desc',
                state: 'opened',
                web_url: 'url',
                target_branch: 'main',
                source_branch: 'feat',
                merge_status: 'can_be_merged',
                detailed_merge_status: 'mergeable',
                diff_refs: {},
            };
            mockGitlabInstance.MergeRequests.show.mockResolvedValue(mockMr);

            const handler = getToolHandler('get_merge_request_details');
            const result = await handler({ project_id: 123, merge_request_iid: 1, verbose: false });

            expect(mockGitlabInstance.MergeRequests.show).toHaveBeenCalledWith(123, 1);
            const content = JSON.parse(result.content[0].text);
            expect(content.title).toBe('MR Title');
        });
    });

    describe('add_merge_request_comment', () => {
        it('should create a discussion note', async () => {
            const mockNote = { id: 1, body: 'comment' };
            mockGitlabInstance.MergeRequestDiscussions.create.mockResolvedValue(mockNote);

            const handler = getToolHandler('add_merge_request_comment');
            const result = await handler({ project_id: 123, merge_request_iid: 1, comment: 'test comment' });

            expect(mockGitlabInstance.MergeRequestDiscussions.create).toHaveBeenCalledWith(123, 1, 'test comment');
            const content = JSON.parse(result.content[0].text);
            expect(content.id).toBe(1);
        });
    });

    describe('get_merge_request_diff', () => {
        it('should return diffs from allDiffs when available', async () => {
            const mockDiffs = [{ old_path: 'a.js', new_path: 'a.js', diff: '@@ -1 +1 @@' }];
            mockGitlabInstance.MergeRequests.allDiffs.mockResolvedValue(mockDiffs);

            const handler = getToolHandler('get_merge_request_diff');
            const result = await handler({ project_id: 123, merge_request_iid: 1 });

            expect(mockGitlabInstance.MergeRequests.allDiffs).toHaveBeenCalledWith(123, 1);
            expect(mockGitlabInstance.MergeRequests.showChanges).not.toHaveBeenCalled();
            const content = JSON.parse(result.content[0].text);
            expect(content).toHaveLength(1);
            expect(content[0].old_path).toBe('a.js');
        });

        it('should fall back to showChanges when allDiffs returns 404', async () => {
            const notFoundError = new Error('404 Not Found');
            notFoundError.cause = { description: '404 Not Found' };
            mockGitlabInstance.MergeRequests.allDiffs.mockRejectedValue(notFoundError);
            mockGitlabInstance.MergeRequests.showChanges.mockResolvedValue({
                changes: [{ old_path: 'b.js', new_path: 'b.js', diff: '@@ -1 +2 @@' }],
            });

            const handler = getToolHandler('get_merge_request_diff');
            const result = await handler({ project_id: 123, merge_request_iid: 170 });

            expect(mockGitlabInstance.MergeRequests.showChanges).toHaveBeenCalledWith(123, 170);
            const content = JSON.parse(result.content[0].text);
            expect(content[0].old_path).toBe('b.js');
        });
    });

    describe('add_merge_request_diff_comment', () => {
        it('should create a diff comment', async () => {
            const mockDiscussion = { id: 1 };
            mockGitlabInstance.MergeRequestDiscussions.create.mockResolvedValue(mockDiscussion);

            const args = {
                project_id: 123,
                merge_request_iid: 1,
                comment: 'diff comment',
                base_sha: 'base',
                start_sha: 'start',
                head_sha: 'head',
                file_path: 'file.js',
                line_number: '10',
            };

            const handler = getToolHandler('add_merge_request_diff_comment');
            await handler(args);

            expect(mockGitlabInstance.MergeRequestDiscussions.create).toHaveBeenCalledWith(
                123,
                1,
                'diff comment',
                {
                    position: {
                        base_sha: 'base',
                        start_sha: 'start',
                        head_sha: 'head',
                        old_path: 'file.js',
                        new_path: 'file.js',
                        position_type: 'text',
                        new_line: '10',
                    },
                }
            );
        });
    });

    describe('get_merge_request_comments', () => {
        it('should include discussion_id for unresolved notes', async () => {
            mockGitlabInstance.MergeRequestDiscussions.all.mockResolvedValue([
                {
                    id: 'discussion-1',
                    notes: [
                        {
                            id: 10,
                            noteable_id: 1,
                            body: 'inline comment',
                            author: { name: 'Reviewer' },
                            type: 'DiffNote',
                            resolved: false,
                            position: { new_path: 'src/a.ts' },
                        },
                    ],
                },
            ]);

            const handler = getToolHandler('get_merge_request_comments');
            const result = await handler({ project_id: 123, merge_request_iid: 1, verbose: false });

            const content = JSON.parse(result.content[0].text);
            expect(content.diffNotes).toHaveLength(1);
            expect(content.diffNotes[0].discussion_id).toBe('discussion-1');
            expect(content.diffNotes[0].id).toBe(10);
        });
    });

    describe('resolve_merge_request_discussion', () => {
        it('should resolve a discussion by discussion_id', async () => {
            mockGitlabInstance.MergeRequestDiscussions.resolve.mockResolvedValue({ id: 'discussion-1' });

            const handler = getToolHandler('resolve_merge_request_discussion');
            const result = await handler({
                project_id: 123,
                merge_request_iid: 1,
                discussion_id: 'discussion-1',
                resolved: true,
            });

            expect(mockGitlabInstance.MergeRequestDiscussions.resolve).toHaveBeenCalledWith(
                123,
                1,
                'discussion-1',
                true,
            );
            const content = JSON.parse(result.content[0].text);
            expect(content.discussion_id).toBe('discussion-1');
            expect(content.resolved).toBe(true);
        });

        it('should resolve a discussion by note_id', async () => {
            mockGitlabInstance.MergeRequestDiscussions.all.mockResolvedValue([
                {
                    id: 'discussion-2',
                    notes: [{ id: 42, resolved: false }],
                },
            ]);
            mockGitlabInstance.MergeRequestDiscussions.resolve.mockResolvedValue({ id: 'discussion-2' });

            const handler = getToolHandler('resolve_merge_request_discussion');
            await handler({
                project_id: 123,
                merge_request_iid: 1,
                note_id: 42,
                resolved: true,
            });

            expect(mockGitlabInstance.MergeRequestDiscussions.resolve).toHaveBeenCalledWith(
                123,
                1,
                'discussion-2',
                true,
            );
        });
    });

    describe('resolve_all_merge_request_discussions', () => {
        it('should resolve all unresolved discussions', async () => {
            mockGitlabInstance.MergeRequestDiscussions.all.mockResolvedValue([
                {
                    id: 'discussion-1',
                    notes: [{ id: 1, type: 'DiffNote', resolved: false }],
                },
                {
                    id: 'discussion-2',
                    notes: [{ id: 2, type: 'DiscussionNote', resolved: true }],
                },
            ]);
            mockGitlabInstance.MergeRequestDiscussions.resolve.mockResolvedValue({ id: 'discussion-1' });

            const handler = getToolHandler('resolve_all_merge_request_discussions');
            const result = await handler({
                project_id: 123,
                merge_request_iid: 1,
                resolved: true,
                only_unresolved: true,
                only_diff_threads: false,
            });

            expect(mockGitlabInstance.MergeRequestDiscussions.resolve).toHaveBeenCalledTimes(1);
            expect(mockGitlabInstance.MergeRequestDiscussions.resolve).toHaveBeenCalledWith(
                123,
                1,
                'discussion-1',
                true,
            );
            const content = JSON.parse(result.content[0].text);
            expect(content.count).toBe(1);
        });
    });

    describe('set_merge_request_title', () => {
        it('should update MR title', async () => {
            const mockMr = { iid: 1, title: 'New Title' };
            mockGitlabInstance.MergeRequests.edit.mockResolvedValue(mockMr);

            const handler = getToolHandler('set_merge_request_title');
            const result = await handler({ project_id: 123, merge_request_iid: 1, title: 'New Title' });

            expect(mockGitlabInstance.MergeRequests.edit).toHaveBeenCalledWith(123, 1, { title: 'New Title' });
            const content = JSON.parse(result.content[0].text);
            expect(content.title).toBe('New Title');
        });
    });

    describe('approve_merge_request', () => {
        it('should approve a merge request', async () => {
            const mockApproval = { id: 1, approved_by: [{ user: { name: 'Reviewer' } }] };
            mockGitlabInstance.MergeRequestApprovals.approve.mockResolvedValue(mockApproval);

            const handler = getToolHandler('approve_merge_request');
            const result = await handler({ project_id: 123, merge_request_iid: 1 });

            expect(mockGitlabInstance.MergeRequestApprovals.approve).toHaveBeenCalledWith(123, 1, undefined);
            const content = JSON.parse(result.content[0].text);
            expect(content.approved).toBe(true);
            expect(content.merge_request_iid).toBe(1);
        });

        it('should approve with optional sha', async () => {
            mockGitlabInstance.MergeRequestApprovals.approve.mockResolvedValue({ id: 1 });

            const handler = getToolHandler('approve_merge_request');
            await handler({
                project_id: 123,
                merge_request_iid: 1,
                sha: 'abc123',
            });

            expect(mockGitlabInstance.MergeRequestApprovals.approve).toHaveBeenCalledWith(123, 1, {
                sha: 'abc123',
            });
        });
    });

    describe('unapprove_merge_request', () => {
        it('should revoke MR approval', async () => {
            mockGitlabInstance.MergeRequestApprovals.unapprove.mockResolvedValue(undefined);

            const handler = getToolHandler('unapprove_merge_request');
            const result = await handler({ project_id: 123, merge_request_iid: 1 });

            expect(mockGitlabInstance.MergeRequestApprovals.unapprove).toHaveBeenCalledWith(123, 1);
            const content = JSON.parse(result.content[0].text);
            expect(content.approved).toBe(false);
        });
    });

    describe('Error Handling', () => {
        it('should return error response when API fails', async () => {
            mockGitlabInstance.Projects.all.mockRejectedValue(new Error('API Error'));

            const handler = getToolHandler('get_projects');
            const result = await handler({ verbose: false });

            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain('Error: API Error');
        });
    });
});
