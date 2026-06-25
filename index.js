import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Gitlab } from "@gitbeaker/rest";
import { fileURLToPath } from "url";
import { exec } from "child_process";
import { promisify } from "util";
import { z } from "zod";
import _ from "lodash";

// Promisify exec for async usage
const execAsync = promisify(exec);

// Initialize GitLab API Client
const gitlabToken = process.env.MR_MCP_GITLAB_TOKEN;
if (!gitlabToken) {
  console.error("Error: MR_MCP_GITLAB_TOKEN environment variable is not set.");
}

const api = new Gitlab({
  host: process.env.MR_MCP_GITLAB_HOST,
  token: gitlabToken,
});

// Helper function to format errors for MCP responses
const formatErrorResponse = (error) => ({
  content: [
    {
      type: "text",
      text: `Error: ${error.message} - ${error.cause?.description || "No additional details"}`,
    },
  ],
  isError: true,
});

const findDiscussionIdByNoteId = async (projectId, mergeRequestIid, noteId) => {
  const discussions = await api.MergeRequestDiscussions.all(
    projectId,
    mergeRequestIid,
  );

  for (const discussion of discussions) {
    if (discussion.notes?.some((note) => note.id === noteId)) {
      return discussion.id;
    }
  }

  return null;
};

const mapUnresolvedComments = (discussions) => {
  const diffNotes = [];
  const disscussionNotes = [];

  for (const discussion of discussions) {
    for (const note of discussion.notes ?? []) {
      if (note.resolved !== false) {
        continue;
      }

      const mappedNote = {
        discussion_id: discussion.id,
        id: note.id,
        noteable_id: note.noteable_id,
        body: note.body,
        author_name: note.author?.name,
      };

      if (note.type === "DiffNote") {
        diffNotes.push({
          ...mappedNote,
          position: note.position,
        });
      } else if (note.type === "DiscussionNote") {
        disscussionNotes.push(mappedNote);
      }
    }
  }

  return { disscussionNotes, diffNotes };
};

const hasUnresolvedDiscussions = async (projectId, mergeRequestIid) => {
  const discussions = await api.MergeRequestDiscussions.all(
    projectId,
    mergeRequestIid,
  );
  const { diffNotes, disscussionNotes } = mapUnresolvedComments(discussions);

  return diffNotes.length > 0 || disscussionNotes.length > 0;
};

// Initialize the MCP server
const server = new McpServer({
  name: "GitlabMrMCP",
  version: "1.0.0",
});

// --- Merge Request Tools ---
server.tool(
  "get_projects",
  "Get a list of projects with id, name, description, web_url and other useful information.",
  {
    verbose: z
      .boolean()
      .default(false)
      .describe(
        "By default a filtered version is returned, suitable for most cases. Only set true if more information is needed.",
      ),
  },
  async ({ verbose }) => {
    try {
      const projectFilter = {
        ...(process.env.MR_MCP_MIN_ACCESS_LEVEL
          ? {
              minAccessLevel: parseInt(process.env.MR_MCP_MIN_ACCESS_LEVEL, 10),
            }
          : {}),
        ...(process.env.MR_MCP_PROJECT_SEARCH_TERM
          ? { search: process.env.MR_MCP_PROJECT_SEARCH_TERM }
          : {}),
      };
      const projects = await api.Projects.all({
        membership: true,
        ...projectFilter,
      });
      const filteredProjects = verbose
        ? projects
        : projects.map((project) => ({
            id: project.id,
            description: project.description,
            name: project.name,
            path: project.path,
            path_with_namespace: project.path_with_namespace,
            web_url: project.web_url,
            default_branch: project.default_branch,
          }));

      const projectsText =
        Array.isArray(filteredProjects) && filteredProjects.length > 0
          ? JSON.stringify(filteredProjects, null, 2)
          : "No projects found.";
      return {
        content: [{ type: "text", text: projectsText }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  },
);

server.tool(
  "list_open_merge_requests",
  "Lists all open merge requests in the project",
  {
    project_id: z.number().describe("The project ID of the merge request"),
    verbose: z
      .boolean()
      .default(false)
      .describe(
        "By default a filtered version is returned, suitable for most cases. Only set true if more information is needed.",
      ),
  },
  async ({ verbose, project_id }) => {
    try {
      const mergeRequests = await api.MergeRequests.all({
        projectId: project_id,
        state: "opened",
      });

      const filteredMergeRequests = verbose
        ? mergeRequests
        : mergeRequests.map((mr) => ({
            iid: mr.iid,
            project_id: mr.project_id,
            title: mr.title,
            description: mr.description,
            state: mr.state,
            web_url: mr.web_url,
          }));
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(filteredMergeRequests, null, 2),
          },
        ],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  },
);

server.tool(
  "get_merge_request_details",
  "Get details about a specific merge request of a project like title, source-branch, target-branch, web_url, ...",
  {
    project_id: z.number().describe("The project ID of the merge request"),
    merge_request_iid: z
      .number()
      .describe("The internal ID of the merge request within the project"),
    verbose: z
      .boolean()
      .default(false)
      .describe(
        "By default a filtered version is returned, suitable for most cases. Only set true if more information is needed.",
      ),
  },
  async ({ project_id, merge_request_iid, verbose }) => {
    try {
      const mr = await api.MergeRequests.show(project_id, merge_request_iid);
      const filteredMr = verbose
        ? mr
        : {
            title: mr.title,
            description: mr.description,
            state: mr.state,
            web_url: mr.web_url,
            target_branch: mr.target_branch,
            source_branch: mr.source_branch,
            merge_status: mr.merge_status,
            detailed_merge_status: mr.detailed_merge_status,
            diff_refs: mr.diff_refs,
          };
      return {
        content: [{ type: "text", text: JSON.stringify(filteredMr, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  },
);

server.tool(
  "get_merge_request_comments",
  "Get general and file diff comments of a certain merge request",
  {
    project_id: z.number().describe("The project ID of the merge request"),
    merge_request_iid: z
      .number()
      .describe("The internal ID of the merge request within the project"),
    verbose: z
      .boolean()
      .default(false)
      .describe(
        "By default a filtered version is returned, suitable for most cases. Only set true if more information is needed.",
      ),
  },
  async ({ project_id, merge_request_iid, verbose }) => {
    try {
      const discussions = await api.MergeRequestDiscussions.all(
        project_id,
        merge_request_iid,
      );

      if (verbose) {
        return {
          content: [
            { type: "text", text: JSON.stringify(discussions, null, 2) },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(mapUnresolvedComments(discussions), null, 2),
          },
        ],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  },
);

server.tool(
  "add_merge_request_comment",
  "Add a general comment to a merge request",
  {
    project_id: z.number().describe("The project ID of the merge request"),
    merge_request_iid: z
      .number()
      .describe("The internal ID of the merge request within the project"),
    comment: z.string().describe("The comment text"),
  },
  async ({ project_id, merge_request_iid, comment }) => {
    try {
      const note = await api.MergeRequestDiscussions.create(
        project_id,
        merge_request_iid,
        comment,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(note, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  },
);

server.tool(
  "add_merge_request_diff_comment",
  "Add a comment of a merge request at a specific line in a file diff",
  {
    project_id: z.number().describe("The project ID of the merge request"),
    merge_request_iid: z
      .number()
      .describe("The internal ID of the merge request within the project"),
    comment: z.string().describe("The comment text"),
    base_sha: z.string().describe("The SHA of the base commit"),
    start_sha: z.string().describe("The SHA of the start commit"),
    head_sha: z.string().describe("The SHA of the head commit"),
    file_path: z.string().describe("The path to the file being commented on"),
    line_number: z
      .string()
      .describe("The line number in the new version of the file"),
  },
  async ({
    project_id,
    merge_request_iid,
    comment,
    base_sha,
    start_sha,
    head_sha,
    file_path,
    line_number,
  }) => {
    try {
      const discussion = await api.MergeRequestDiscussions.create(
        project_id,
        merge_request_iid,
        comment,
        {
          position: {
            base_sha: base_sha,
            start_sha: start_sha,
            head_sha: head_sha,
            old_path: file_path,
            new_path: file_path,
            position_type: "text",
            new_line: line_number,
          },
        },
      );
      return {
        content: [{ type: "text", text: JSON.stringify(discussion, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  },
);

server.tool(
  "resolve_merge_request_discussion",
  "Resolve or unresolve a merge request discussion thread (inline diff comment thread or general thread). Use discussion_id from get_merge_request_comments.",
  {
    project_id: z.number().describe("The project ID of the merge request"),
    merge_request_iid: z
      .number()
      .describe("The internal ID of the merge request within the project"),
    discussion_id: z
      .string()
      .optional()
      .describe(
        "Discussion ID from get_merge_request_comments (discussion_id field on a note)",
      ),
    note_id: z
      .number()
      .optional()
      .describe("Alternative: resolve the thread that contains this note ID"),
    resolved: z
      .boolean()
      .default(true)
      .describe("true to resolve the thread, false to unresolve"),
  },
  async ({
    project_id,
    merge_request_iid,
    discussion_id,
    note_id,
    resolved,
  }) => {
    try {
      let targetDiscussionId = discussion_id;

      if (!targetDiscussionId && note_id != null) {
        targetDiscussionId = await findDiscussionIdByNoteId(
          project_id,
          merge_request_iid,
          note_id,
        );
        if (!targetDiscussionId) {
          return formatErrorResponse(
            new Error(`Discussion not found for note_id ${note_id}`),
          );
        }
      }

      if (!targetDiscussionId) {
        return formatErrorResponse(
          new Error("Either discussion_id or note_id is required"),
        );
      }

      const discussion = await api.MergeRequestDiscussions.resolve(
        project_id,
        merge_request_iid,
        targetDiscussionId,
        resolved,
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                discussion_id: targetDiscussionId,
                resolved,
                discussion,
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  },
);

server.tool(
  "resolve_all_merge_request_discussions",
  "Resolve or unresolve all discussion threads in a merge request (optionally only unresolved or only inline diff threads)",
  {
    project_id: z.number().describe("The project ID of the merge request"),
    merge_request_iid: z
      .number()
      .describe("The internal ID of the merge request within the project"),
    resolved: z
      .boolean()
      .default(true)
      .describe("true to resolve, false to unresolve"),
    only_unresolved: z
      .boolean()
      .default(true)
      .describe("When resolving, only threads that are currently unresolved"),
    only_diff_threads: z
      .boolean()
      .default(false)
      .describe("Only threads that contain inline diff comments"),
  },
  async ({
    project_id,
    merge_request_iid,
    resolved,
    only_unresolved,
    only_diff_threads,
  }) => {
    try {
      const discussions = await api.MergeRequestDiscussions.all(
        project_id,
        merge_request_iid,
      );
      const targetDiscussions = discussions.filter((discussion) => {
        const notes = discussion.notes ?? [];
        const hasDiffNote = notes.some((note) => note.type === "DiffNote");
        const isUnresolved = notes.some((note) => note.resolved === false);
        const isResolved =
          notes.length > 0 && notes.every((note) => note.resolved === true);

        if (only_diff_threads && !hasDiffNote) {
          return false;
        }

        if (only_unresolved && resolved) {
          return isUnresolved;
        }

        if (only_unresolved && !resolved) {
          return isResolved;
        }

        return true;
      });

      const results = [];

      for (const discussion of targetDiscussions) {
        const updated = await api.MergeRequestDiscussions.resolve(
          project_id,
          merge_request_iid,
          discussion.id,
          resolved,
        );
        results.push({
          discussion_id: discussion.id,
          resolved,
          discussion: updated,
        });
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                count: results.length,
                resolved,
                discussions: results,
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  },
);

server.tool(
  "get_merge_request_diff",
  "Get the file diffs of a certain merge request",
  {
    project_id: z.number().describe("The project ID of the merge request"),
    merge_request_iid: z
      .number()
      .describe("The internal ID of the merge request within the project"),
  },
  async ({ project_id, merge_request_iid }) => {
    try {
      let changes;
      try {
        changes = await api.MergeRequests.allDiffs(
          project_id,
          merge_request_iid,
        );
      } catch (error) {
        // Older GitLab instances expose /changes but not /diffs (404).
        if (error.cause?.description !== "404 Not Found") {
          throw error;
        }
        const response = await api.MergeRequests.showChanges(
          project_id,
          merge_request_iid,
        );
        changes = response.changes;
      }

      const diffText =
        Array.isArray(changes) && changes.length > 0
          ? JSON.stringify(changes, null, 2)
          : "No diff data available for this merge request.";
      return {
        content: [{ type: "text", text: diffText }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  },
);

server.tool(
  "get_issue_details",
  "Get details of an issue within a certain project",
  {
    project_id: z.number().describe("The project ID of the issue"),
    issue_iid: z
      .number()
      .describe("The internal ID of the issue within the project"),
    verbose: z
      .boolean()
      .default(false)
      .describe(
        "By default a filtered version is returned, suitable for most cases. Only set true if more information is needed.",
      ),
  },
  async ({ project_id, issue_iid, verbose }) => {
    try {
      const issue = await api.Issues.show(issue_iid, { projectId: project_id });

      const filteredIssue = verbose
        ? issue
        : {
            title: issue.title,
            description: issue.description,
          };

      return {
        content: [
          { type: "text", text: JSON.stringify(filteredIssue, null, 2) },
        ],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  },
);

server.tool(
  "set_merge_request_description",
  "Set the description of a merge request",
  {
    project_id: z.number().describe("The project ID of the merge request"),
    merge_request_iid: z
      .number()
      .describe("The internal ID of the merge request within the project"),
    description: z.string().describe("The description text"),
  },
  async ({ project_id, merge_request_iid, description }) => {
    try {
      const mr = await api.MergeRequests.edit(project_id, merge_request_iid, {
        description,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(mr, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  },
);

server.tool(
  "set_merge_request_title",
  "Set the title of a merge request",
  {
    project_id: z.number().describe("The project ID of the merge request"),
    merge_request_iid: z
      .number()
      .describe("The internal ID of the merge request within the project"),
    title: z.string().describe("The title of the merge request"),
  },
  async ({ project_id, merge_request_iid, title }) => {
    try {
      const mr = await api.MergeRequests.edit(project_id, merge_request_iid, {
        title,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(mr, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  },
);

server.tool(
  "approve_merge_request",
  "Approve a merge request (GitLab MR approval). Requires api token scope.",
  {
    project_id: z.number().describe("The project ID of the merge request"),
    merge_request_iid: z
      .number()
      .describe("The internal ID of the merge request within the project"),
    sha: z
      .string()
      .optional()
      .describe(
        "Optional commit SHA to approve (head_sha from diff_refs for strict approval)",
      ),
  },
  async ({ project_id, merge_request_iid, sha }) => {
    try {
      const approval = await api.MergeRequestApprovals.approve(
        project_id,
        merge_request_iid,
        sha ? { sha } : undefined,
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                approved: true,
                merge_request_iid,
                approval,
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  },
);

server.tool(
  "unapprove_merge_request",
  "Revoke approval of a merge request",
  {
    project_id: z.number().describe("The project ID of the merge request"),
    merge_request_iid: z
      .number()
      .describe("The internal ID of the merge request within the project"),
  },
  async ({ project_id, merge_request_iid }) => {
    try {
      await api.MergeRequestApprovals.unapprove(project_id, merge_request_iid);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                approved: false,
                merge_request_iid,
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  },
);

// Connect the server to a transport and start it
async function runServer() {
  try {
    const transport = new StdioServerTransport();
    await server.connect(transport);
  } catch (error) {
    console.error("Failed to start server:", error.message);
    process.exit(1);
  }
}

// Only run the server if this file is the main module
const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  runServer();
}

export {
  server,
  api,
  findDiscussionIdByNoteId,
  mapUnresolvedComments,
  hasUnresolvedDiscussions,
};
