//      
import chalk from 'chalk';
import wait from '../output/wait';
import joinWords from '../output/join-words';

                                                                     
import * as Errors from '../errors';

async function setScale(
  output        ,
  now     ,
  deploymentId        ,
  scaleArgs                                       ,
  url        
) {
  const cancelWait = wait(
    `Setting scale rules for ${joinWords(
      Object.keys(scaleArgs).map(dc => `${chalk.bold(dc)}`)
    )}`
  );

  try {
    await now.fetch(
      `/v3/now/deployments/${encodeURIComponent(deploymentId)}/instances`,
      {
        method: 'PUT',
        body: scaleArgs
      }
    );
    cancelWait();
  } catch (error) {
    cancelWait();
    if (error.code === 'forbidden_min_instances') {
      return new Errors.ForbiddenScaleMinInstances(url, error.min);
    } if (error.code === 'forbidden_max_instances') {
      return new Errors.ForbiddenScaleMaxInstances(url, error.max);
    } if (error.code === 'wrong_min_max_relation') {
      return new Errors.InvalidScaleMinMaxRelation(url);
    } if (error.code === 'not_supported_min_scale_slots') {
      return new Errors.NotSupportedMinScaleSlots(url);
    } 
      throw error;
    
  }
}

export default setScale;
