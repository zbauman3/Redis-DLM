import { $ } from 'zx';

(async ()=>{

	try{

		await $`docker exec ${(process.stdout.isTTY ? '-ti' : '-i')} nodeJS npx jest ${process.argv.slice(3)}`;

	}catch(_){ /** noop */ }

})();