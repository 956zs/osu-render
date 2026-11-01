import { main } from './plugins/cli.js';

// npm run plugin -- list | install <folder|file.zip> [--force] | remove <id>
process.exitCode = await main(process.argv.slice(2));
