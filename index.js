import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { WebSocketClientTransport } from "@modelcontextprotocol/sdk/client/websocket.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import inquirer from "inquirer";
import { generateObject, jsonSchema } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
// Parse command line arguments
function parseArgs() {
    const args = process.argv.slice(2);
    // Find URL argument (format: --url=http://example.com)
    const urlArg = args.find(arg => arg.startsWith('--url='));
    let serverUrl = 'ws://localhost:8000/ws'; // Default server with protocol
    if (urlArg) {
        serverUrl = urlArg.split('=')[1];
        // Add default protocol if none provided
        if (!serverUrl.startsWith('http') && !serverUrl.startsWith('ws')) {
            serverUrl = `ws://${serverUrl}`;
        }
    }
    // Determine transport type from URL protocol
    const transportType = serverUrl.startsWith('http') ? 'sse' : 'ws';
    return { transportType, serverUrl };
}
async function main() {
    try {
        const { transportType, serverUrl } = parseArgs();
        console.log(`Connecting to MCP server at ${serverUrl} using ${transportType.toUpperCase()} transport...`);
        let transport;
        if (transportType === 'sse') {
            transport = new SSEClientTransport(new URL("/sse", serverUrl));
        }
        else {
            transport = new WebSocketClientTransport(new URL("/ws", serverUrl));
        }
        const client = new Client({
            name: "webdraw",
            version: "1.0.0",
        }, {
            capabilities: {
                prompts: {},
                resources: {},
                tools: {},
            },
        });
        await client.connect(transport);
        console.log("Connected successfully!");
        // Main menu loop
        let exit = false;
        while (!exit) {
            const { action } = await inquirer.prompt([
                {
                    type: 'list',
                    name: 'action',
                    message: 'What would you like to do?',
                    choices: [
                        'List all tools',
                        'Test a tool',
                        'Exit'
                    ]
                }
            ]);
            switch (action) {
                case 'List all tools':
                    await listTools(client);
                    break;
                case 'Test a tool':
                    await testTool(client);
                    break;
                case 'Exit':
                    exit = true;
                    console.log('Goodbye!');
                    process.exit(0);
            }
        }
        // Close the connection when done
        await transport.close();
    }
    catch (error) {
        console.error('Error:', error instanceof Error ? error.message : error);
        process.exit(1);
    }
}
async function listTools(client) {
    console.log('Fetching available tools...');
    const { tools } = await client.listTools();
    if (tools.length === 0) {
        console.log('No tools available.');
        return;
    }
    console.log('\nAvailable tools:');
    tools.forEach((tool, index) => {
        const description = tool.description || 'No description';
        const truncatedDesc = description.length > 40 ? description.slice(0, 30) + '...' : description;
        console.log(`${index + 1}. ${tool.name} - ${truncatedDesc}`);
    });
}
async function testTool(client) {
    const { tools } = await client.listTools();
    if (tools.length === 0) {
        console.log('No tools available to test.');
        return;
    }
    // Create choices for tool selection
    const toolChoices = tools.map((tool, index) => {
        const description = tool.description || 'No description';
        const truncatedDesc = description.length > 40 ? description.slice(0, 30) + '...' : description;
        return {
            name: `${tool.name} - ${truncatedDesc}`,
            value: index
        };
    });
    const { toolIndex } = await inquirer.prompt([
        {
            type: 'list',
            name: 'toolIndex',
            message: 'Select a tool to test:',
            choices: toolChoices
        }
    ]);
    const selectedTool = tools[toolIndex];
    console.log(`\nSelected tool: ${selectedTool.name}`);
    // Get parameters for the tool if needed
    let params = {};
    if (selectedTool.inputSchema?.properties) {
        console.log('\nThis tool requires parameters.');
        const { usePrompt } = await inquirer.prompt([
            {
                type: 'confirm',
                name: 'usePrompt',
                message: 'Would you like to use an LLM prompt to fill in the parameters?',
                default: false
            }
        ]);
        if (usePrompt) {
            // Check if ANTHROPIC_API_KEY is set
            if (!process.env.ANTHROPIC_API_KEY) {
                const { apiKey } = await inquirer.prompt([
                    {
                        type: 'password',
                        name: 'apiKey',
                        message: 'Please enter your Anthropic API key:',
                        validate: (input) => input.length > 0 ? true : 'API key is required'
                    }
                ]);
                // Set the API key for this session
                process.env.ANTHROPIC_API_KEY = apiKey;
            }
            const { prompt } = await inquirer.prompt([
                {
                    type: 'input',
                    name: 'prompt',
                    message: 'Enter a prompt to fill in the parameters:',
                }
            ]);
            const model = anthropic("claude-3-7-sonnet-latest");
            const { object } = await generateObject({
                model,
                schema: jsonSchema(selectedTool.inputSchema),
                prompt: prompt,
            });
            console.log("\n[GENERATED INPUT]\n", object, "\n");
            params = object;
        }
        else {
            for (const [paramName, paramSchema] of Object.entries(selectedTool.inputSchema.properties)) {
                const schema = paramSchema;
                const { value } = await inquirer.prompt([
                    {
                        type: 'input',
                        name: 'value',
                        message: `Enter value for ${paramName} (${schema.description || 'No description'}):`,
                        default: schema.default
                    }
                ]);
                params[paramName] = value;
            }
        }
    }
    try {
        console.log('\nExecuting tool...');
        const result = await client.callTool({
            name: selectedTool.name,
            arguments: params,
        });
        console.log('\nTool execution result:');
        if (!Array.isArray(result.content)) {
            console.log(result.content);
            return;
        }
        for (const content of result.content) {
            if (content.type === "text") {
                console.log(content.text);
            }
        }
    }
    catch (error) {
        if (error instanceof Error) {
            console.error(`Error executing tool ${selectedTool.name}:`, error.message);
        }
        else {
            console.error(`Error executing tool ${selectedTool.name}:`, error);
        }
    }
}
// Run the main function
main().catch(error => {
    console.error('Unhandled error:', error);
    process.exit(1);
});
