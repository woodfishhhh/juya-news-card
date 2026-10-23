import {replayFeedIntake} from '../lib/feed-intake.mjs';
import * as html from '../lib/html.mjs';
import {discover} from '../adapters/feeds.mjs';
if (process.argv.length !== 3) throw new Error('Usage: node bin/replay-feed-intake.mjs INTAKE.json');
console.log(JSON.stringify(await replayFeedIntake(process.argv[2], html, discover)));
