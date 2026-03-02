import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// Create the MCP server instance
const server = new McpServer({
  name: "Weather MCP Server",
  version: "1.0.0",
});

// Register a tool to get current weather using Open-Meteo (free, no API key needed).
server.tool(
  "get_weather",
  "Get current weather for a location using latitude and longitude",
  {
    latitude: z.number().describe("Latitude of the location"),
    longitude: z.number().describe("Longitude of the location"),
  },
  async ({ latitude, longitude }) => {
    try {
      // Open-Meteo is a free weather API that doesn't require an API key
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code&temperature_unit=celsius`;

      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`Weather API error: ${response.status}`);
      }

      const data = (await response.json()) as {
        current: {
          temperature_2m: number;
          relative_humidity_2m: number;
          wind_speed_10m: number;
          weather_code: number;
        };
      };

      // Map weather codes to descriptions
      const weatherDescriptions: Record<number, string> = {
        0: "Clear sky",
        1: "Mainly clear",
        2: "Partly cloudy",
        3: "Overcast",
        45: "Foggy",
        48: "Depositing rime fog",
        51: "Light drizzle",
        53: "Moderate drizzle",
        55: "Dense drizzle",
        61: "Slight rain",
        63: "Moderate rain",
        65: "Heavy rain",
        71: "Slight snow",
        73: "Moderate snow",
        75: "Heavy snow",
        80: "Slight rain showers",
        81: "Moderate rain showers",
        82: "Violent rain showers",
        95: "Thunderstorm",
      };

      const weatherDescription =
        weatherDescriptions[data.current.weather_code] || "Unknown";

      const result = {
        temperature: `${data.current.temperature_2m}°C`,
        humidity: `${data.current.relative_humidity_2m}%`,
        windSpeed: `${data.current.wind_speed_10m} km/h`,
        conditions: weatherDescription,
        location: { latitude, longitude },
      };

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error fetching weather: ${error instanceof Error ? error.message : "Unknown error"}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// Register a tool to search for a city and get its coordinates
server.tool(
  "search_city",
  "Search for a city and get its coordinates",
  {
    city: z.string().describe("Name of the city to search for"),
  },
  async ({ city }) => {
    try {
      // Open-Meteo geocoding API (free, no API key needed)
      const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=5&language=en&format=json`;

      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`Geocoding API error: ${response.status}`);
      }

      const data = (await response.json()) as {
        results?: Array<{
          name: string;
          country: string;
          admin1?: string;
          latitude: number;
          longitude: number;
        }>;
      };

      if (!data.results || data.results.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No cities found matching "${city}"`,
            },
          ],
        };
      }

      const cities = data.results.map((r) => ({
        name: r.name,
        country: r.country,
        region: r.admin1 || "N/A",
        latitude: r.latitude,
        longitude: r.longitude,
      }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(cities, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error searching for city: ${error instanceof Error ? error.message : "Unknown error"}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// Export the Worker fetch handler
export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    // Handle CORS preflight requests
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    const url = new URL(request.url);

    // Simple info endpoint
    if (url.pathname === "/" || url.pathname === "") {
      return new Response(
        JSON.stringify({
          name: "Weather MCP Server",
          version: "1.0.0",
          description:
            "An MCP server that provides weather information using Open-Meteo API",
          mcpEndpoint: "/mcp",
          tools: ["get_weather", "search_city"],
        }),
        {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        }
      );
    }

    // MCP endpoint - handles all MCP protocol communication
    if (url.pathname === "/mcp") {
      const handler = createMcpHandler(server);
      return handler(request, env, ctx);
    }

    return new Response("Not Found", { status: 404 });
  },
};
