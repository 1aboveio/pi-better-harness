import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createTaskExecutor} from './exec.ts';

for(const kind of ['argv','shell'])test(`worker bridge credentials are not inherited by ${kind} task execution`,async()=>{
 const previous=process.env.PI_BETTER_OPERATIONS_TOKEN;
 const previousEndpoint=process.env.PI_BETTER_OPERATIONS_ENDPOINT;
 process.env.PI_BETTER_OPERATIONS_TOKEN='private-test-capability';
 process.env.PI_BETTER_OPERATIONS_ENDPOINT='unix:/private-test-socket';
 const output:Buffer[]=[];
 const run=createTaskExecutor({requireLaunchPlan:()=>({confined:false})});
 const script='console.log(JSON.stringify({token:process.env.PI_BETTER_OPERATIONS_TOKEN??null,endpoint:process.env.PI_BETTER_OPERATIONS_ENDPOINT??null,ordinary:process.env.ORDINARY_VALUE}))';
 const target=kind==='argv'?{kind:'argv' as const,execPath:process.execPath,execArgs:['-e',script]}:{kind:'shell' as const,command:`'${process.execPath.replaceAll("'","'\\''")}' -e '${script.replaceAll("'","'\\''")}'`};
 try{
  const result=await run(target,process.cwd(),{onData:chunk=>output.push(chunk),env:{ORDINARY_VALUE:'kept'}});
  assert.equal(result.exitCode,0);
  assert.deepEqual(JSON.parse(Buffer.concat(output).toString('utf8')),{token:null,endpoint:null,ordinary:'kept'});
  assert.equal(process.env.PI_BETTER_OPERATIONS_TOKEN,'private-test-capability','trusted runtime retains its own client configuration');
 }finally{
  if(previous===undefined)delete process.env.PI_BETTER_OPERATIONS_TOKEN;else process.env.PI_BETTER_OPERATIONS_TOKEN=previous;
  if(previousEndpoint===undefined)delete process.env.PI_BETTER_OPERATIONS_ENDPOINT;else process.env.PI_BETTER_OPERATIONS_ENDPOINT=previousEndpoint;
 }
});
