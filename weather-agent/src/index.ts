import { Agent, routeAgentRequest } from "agents";
import { createWorkersAI } from "workers-ai-provider";
import { streamText } from "ai";

// Define environment bindings.
type Env = {
  WeatherAgent: DurableObjectNamespace<WeatherAgent>;
  AI: Ai; // Workers AI binding
};

// The Agent class extends the base Agent from the Agents SDK
// It runs as a Durable Object, which means it maintains state between requests
export class WeatherAgent extends Agent<Env> {
  // Handle incoming HTTP requests to the agent
  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // ============================================================
    // NEW: Natural language chat endpoint with streaming response
    // ============================================================
    if (url.pathname === "/chat" && request.method === "POST") {
      try {
        const body = (await request.json()) as { message: string };
        const { message } = body;

        if (!message) {
          return new Response(
            JSON.stringify({ error: "message is required" }),
            {
              status: 400,
              headers: { "Content-Type": "application/json" },
            }
          );
        }

        // Check if we have any MCP servers connected
        const servers = this.getMcpServers();
        const connectedServers = Object.values(servers).filter(
          (s) => s.state === "ready"
        );

        if (connectedServers.length === 0) {
          return new Response(
            JSON.stringify({
              error:
                "No MCP servers connected. Use POST /connect first to connect to a weather MCP server.",
              hint: 'POST /connect with body: {"mcpServerUrl": "http://localhost:8787/mcp"}',
            }),
            {
              status: 400,
              headers: { "Content-Type": "application/json" },
            }
          );
        }

        // Get all MCP tools in AI SDK compatible format
        // This automatically includes tools from all connected MCP servers
        const tools = this.mcp.getAITools();

        // Create the Workers AI provider
        // Using Llama 3.1 8B which supports function/tool calling
        const workersai = createWorkersAI({ binding: this.env.AI });

        // System prompt to guide the LLM's behavior
        const systemPrompt = `You are a helpful weather assistant. You have access to tools that can:
1. Search for cities to get their coordinates (search_city)
2. Get current weather for a location using coordinates (get_weather)

When a user asks about weather for a location:
1. First use search_city to find the coordinates
2. Then use get_weather with those coordinates
3. Present the weather information in a friendly, readable format

Always be helpful and concise in your responses.`;

        // Use streamText for streaming responses
        // maxSteps allows the LLM to make multiple tool calls in sequence
        const result = streamText({
          model: workersai("@cf/meta/llama-3.1-8b-instruct"),
          system: systemPrompt,
          messages: [{ role: "user", content: message }],
          tools,
          maxSteps: 5, // Allow up to 5 tool calls (search -> get weather -> respond)
        });

        // Return streaming response
        // The AI SDK handles the tool call loop automatically
        return result.toTextStreamResponse({
          headers: {
            // These headers ensure proper streaming behavior
            "Content-Type": "text/x-unknown",
            "content-encoding": "identity",
            "transfer-encoding": "chunked",
          },
        });
      } catch (error) {
        console.error("Chat error:", error);
        return new Response(
          JSON.stringify({
            error: `Chat failed: ${error instanceof Error ? error.message : "Unknown error"}`,
          }),
          {
            status: 500,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
    }

    // ============================================================
    // Existing endpoints for manual MCP operations (kept for learning/debugging)
    // ============================================================

    // Endpoint to connect to an MCP server
    if (url.pathname === "/connect" && request.method === "POST") {
      try {
        const body = (await request.json()) as { mcpServerUrl: string };
        const mcpServerUrl = body.mcpServerUrl;

        if (!mcpServerUrl) {
          return new Response(
            JSON.stringify({ error: "mcpServerUrl is required" }),
            {
              status: 400,
              headers: { "Content-Type": "application/json" },
            }
          );
        }

        // Connect to the MCP server using the Agent's built-in MCP client
        // This method handles all the MCP protocol communication
        const result = await this.addMcpServer("Weather MCP", mcpServerUrl);

        // If the server requires OAuth, it returns an authUrl
        if (result.state === "authenticating") {
          return new Response(
            JSON.stringify({
              status: "authenticating",
              authUrl: result.authUrl,
              serverId: result.id,
            }),
            {
              headers: { "Content-Type": "application/json" },
            }
          );
        }

        return new Response(
          JSON.stringify({
            status: "connected",
            serverId: result.id,
            message: `Successfully connected to MCP server`,
          }),
          {
            headers: { "Content-Type": "application/json" },
          }
        );
      } catch (error) {
        return new Response(
          JSON.stringify({
            error: `Failed to connect: ${error instanceof Error ? error.message : "Unknown error"}`,
          }),
          {
            status: 500,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
    }

    // Endpoint to list all connected MCP servers and their tools
    if (url.pathname === "/servers" && request.method === "GET") {
      const servers = this.getMcpServers();

      // Transform the servers state into a more readable format
      const serverList = Object.entries(servers).map(([id, server]) => ({
        id,
        name: server.name,
        state: server.state,
        tools: server.tools?.map((t) => ({
          name: t.name,
          description: t.description,
        })),
      }));

      return new Response(JSON.stringify(serverList, null, 2), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Endpoint to call a tool on a connected MCP server
    if (url.pathname === "/call-tool" && request.method === "POST") {
      try {
        const body = (await request.json()) as {
          serverId: string;
          toolName: string;
          args: Record<string, unknown>;
        };
        const { serverId, toolName, args } = body;

        if (!serverId || !toolName) {
          return new Response(
            JSON.stringify({ error: "serverId and toolName are required" }),
            {
              status: 400,
              headers: { "Content-Type": "application/json" },
            }
          );
        }

        // Get the MCP servers state
        const servers = this.getMcpServers();
        const server = servers[serverId];

        if (!server) {
          return new Response(
            JSON.stringify({ error: `Server ${serverId} not found` }),
            {
              status: 404,
              headers: { "Content-Type": "application/json" },
            }
          );
        }

        if (server.state !== "ready") {
          return new Response(
            JSON.stringify({
              error: `Server ${serverId} is not ready (state: ${server.state})`,
            }),
            {
              status: 400,
              headers: { "Content-Type": "application/json" },
            }
          );
        }

        // Find and call the tool
        const tool = server.tools?.find((t) => t.name === toolName);
        if (!tool) {
          return new Response(
            JSON.stringify({
              error: `Tool ${toolName} not found on server ${serverId}`,
            }),
            {
              status: 404,
              headers: { "Content-Type": "application/json" },
            }
          );
        }

        // Call the tool using the MCP client
        const result = await server.client.callTool({
          name: toolName,
          arguments: args,
        });

        return new Response(JSON.stringify(result, null, 2), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        return new Response(
          JSON.stringify({
            error: `Failed to call tool: ${error instanceof Error ? error.message : "Unknown error"}`,
          }),
          {
            status: 500,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
    }

    // Endpoint to disconnect from an MCP server
    if (url.pathname === "/disconnect" && request.method === "POST") {
      try {
        const body = (await request.json()) as { serverId: string };
        const { serverId } = body;

        if (!serverId) {
          return new Response(
            JSON.stringify({ error: "serverId is required" }),
            {
              status: 400,
              headers: { "Content-Type": "application/json" },
            }
          );
        }

        await this.removeMcpServer(serverId);

        return new Response(
          JSON.stringify({
            status: "disconnected",
            message: `Disconnected from server ${serverId}`,
          }),
          {
            headers: { "Content-Type": "application/json" },
          }
        );
      } catch (error) {
        return new Response(
          JSON.stringify({
            error: `Failed to disconnect: ${error instanceof Error ? error.message : "Unknown error"}`,
          }),
          {
            status: 500,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
    }

    // Default response with usage instructions
    return new Response(
      JSON.stringify({
        name: "Weather Agent",
        description:
          "An AI-powered agent that connects to MCP servers and uses their tools via natural language",
        quickStart: {
          step1:
            'Connect to MCP server: POST /connect {"mcpServerUrl": "http://localhost:8787/mcp"}',
          step2:
            'Chat with the agent: POST /chat {"message": "What\'s the weather in Tokyo?"}',
        },
        endpoints: {
          "POST /chat": {
            description:
              "Chat with the AI agent using natural language (streaming response)",
            body: { message: "What's the weather in Paris?" },
            note: "Requires at least one MCP server to be connected first",
          },
          "POST /connect": {
            description: "Connect to an MCP server",
            body: { mcpServerUrl: "https://your-mcp-server.workers.dev/mcp" },
          },
          "GET /servers": {
            description: "List all connected MCP servers and their tools",
          },
          "POST /call-tool": {
            description: "Manually call a tool on a connected MCP server",
            body: {
              serverId: "server-id",
              toolName: "tool-name",
              args: {},
            },
          },
          "POST /disconnect": {
            description: "Disconnect from an MCP server",
            body: { serverId: "server-id" },
          },
        },
      }),
      {
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}

// Main Worker entry point
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // routeAgentRequest handles routing to the appropriate Durable Object instance
    // It uses the request URL to determine which agent instance to use
    return (
      (await routeAgentRequest(request, env, { cors: true })) ||
      new Response("Not found", { status: 404 })
    );
  },
};
