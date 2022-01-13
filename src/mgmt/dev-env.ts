import { $, path, argv, chalk } from 'zx'

(async function(){

	let [, argument] = argv._;

	if(!argument){
		argument = 'start';
	}

	if(argument === 'start'){

		await $`docker compose -f ${path.resolve(__dirname, '../../docker/docker-compose.yml')} up --build -d`
		process.exit(0);

	}

	if(argument === 'stop'){

		await $`docker compose -f ${path.resolve(__dirname, '../../docker/docker-compose.yml')} down`
		process.exit(0);

	}

	console.warn( chalk.red('The argument must be must be "start" or "stop".') );
	process.exit(1);

})();