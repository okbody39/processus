/*!
 * Processus, by Cloudb2.
 *
 * This file (and this file only) is licensed under the same slightly modified
 * MIT license that Processus is. It stops evil-doers everywhere:
 *
 *   Permission is hereby granted, free of charge, to any person obtaining
 *   a copy of this software and associated documentation files (the "Software"),
 *   to deal in the Software without restriction, including without limitation
 *   the rights to use, copy, modify, merge, publish, distribute, sublicense,
 *   and/or sell copies of the Software, and to permit persons to whom
 *   the Software is furnished to do so, subject to the following conditions:
 *
 *   The above copyright notice and this permission notice shall be included
 *   in all copies or substantial portions of the Software.
 *
 *   The Software shall be used for Good, not Evil.
 *
 *   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 *   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 *   FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
 *   DEALINGS IN THE SOFTWARE.
 *
 */

var async = require("async");
var uuid = require("node-uuid");
var logger = require('./logger');
var store = require('./persistence/store');

module.exports = {
  execute: execute,
  updateTasks: updateTasks
};

function updateTasks(id, tasks, callback){

  store.load(id, function(err, workflow){
    if(!err){
      workflow = mergeTasks(workflow, tasks);
      execute(workflow, callback);
    }
    else {
      callback(err);
    }
  });
}

function mergeTasks(workflow, tasks) {
    function makeTaskHandler(taskName) {
      return function taskHandler(task, name) {
        if(taskName == name) {
          mergeTask(task, tasks[taskName]);
          return false;
        }
        else {
          //continue scanning
          return true;
        }
      };
    }
    taskNames = Object.keys(tasks);
    for(var x=0; x<taskNames.length; x++){
      scanAllTasks(workflow.tasks, true, makeTaskHandler(taskNames[x]));
    }
    return workflow;
}

function mergeTask(originalTask, newTask){
  //A Handler can only change the data status, conditions and any sub tasks.
  originalTask.data = newTask.data;
  originalTask.status = newTask.status;
  originalTask.error_if = newTask.error_if;
  originalTask.skip_if = newTask.skip_if;
  originalTask.tasks = newTask.tasks;
  //now update time completed
  originalTask['time-completed'] = Date.now();
  originalTask['handler-duration'] = originalTask['time-completed'] - originalTask['time-started'];
  originalTask['total-duration'] = originalTask['time-completed'] - originalTask['time-opened'];
}

/**
 * Executes the supplied workflow for this instance of the processus engine.
 *
 * @param {object} The workflow definition as a JSON object
 * @returns {object} The validated and updated workflow object
 */
function execute(workflow, callback){
  //Initialise store
  store.init(function(err){
    if(!err){
      workflow = validateWorkflow(workflow);
      realExecute(workflow, callback);
    }
    else {
      callback(err, workflow);
    }
  });


  //return workflow;
}

//Validate the supplied workflow and remove any non-JSON things, like functions!
//Sets the initial status of ALL the tasks to 'waiting'
function validateWorkflow(workflow){
  //convert supplied "JSON" object to string and then back again, thus ensuring
  //it really is just JSON (i.e. any evil functions will be ignored)
  var sWorkflow = JSON.stringify(workflow);
  workflow = JSON.parse(sWorkflow);

  //initialise the status of tasks within the workflow
  setTaskStatusWaiting(workflow);

  //Set workflow UUID if not already present.
  if(workflow.id === undefined) {
    workflow.id = uuid.v4();
  }

  //return the result
  return workflow;

}

//Returns all the tasks that have the supplied status, starting at the parent
//and recursing into child tasks if deep = true
function getTasksByStatus(parent, status, deep) {
  var openTasks={};
  scanAllTasks(parent.tasks, deep, function(task, name){
    if(task.status === status){
      openTasks[name] = task;
    }
    return true;

  });
  return openTasks;

}

//Execute the resulting workflow asynchronously recursing for each next set of tasks
function realExecute(workflow, callback) {

  store.save(workflow, function(err){
    if(err){
      callback(err, workflow);
    }
  });

  //Open any waiting (and available) tasks
  openNextAvailableTask(workflow);

  //Get a list of ALL the open tasks
  var openTasks = getTasksByStatus(workflow, 'open', true);
  var taskNames = Object.keys(openTasks);

  //Initialise the task execution queue
  var taskExecutionQueue = [];

  //This function will return a function to be used by async that calls the
  //appopriate handler (as defined by the task)
  function makeTaskExecutionFunction(x){
    return function(callback){
      var n2 = taskNames[x];
      var t2 = openTasks[taskNames[x]];
      //logger.info("Executing - [" + n2 + "] using handler [" + t2.handler + "]");
      t2['time-started'] = Date.now();
      logger.debug("task.skip_if = " + t2.skip_if);
      logger.debug("task.error_if = " + t2.error_if);

      var skip = (t2.skip_if === true || t2.error_if === true);
      if (!skip) {
        //No error or skip condition so execute handler
        require(t2.handler)(workflow.id, n2, t2, callback, logger);
      }
      else {
        var err = null;
        if (t2.error_if === true) {
          err = new Error("Task has error condition set.");
        }
        callback(err, t2);
      }
    };
  }

  //Now cycle through the open tasks, check them to see if they can be executed,
  //and if so, pushed onto the queue
  for (var x=0; x<taskNames.length; x++){

    //make a new execution function ready for async
    var taskFunction = makeTaskExecutionFunction(x);

    //get the task t
    var t = openTasks[taskNames[x]];

    //if the task is open and has no children, queue it to execute
    if(t.status === 'open' && !t.tasks){
      setTaskDataValues(workflow, t);
      setConditionValues(workflow, t);
      taskExecutionQueue.push(taskFunction);
    }
    //if the task has children, but they're ALL completed, queue it to execute
    if(t.status === 'open' && t.tasks){
      if(childHasStatus(t, 'completed', true)){
        setTaskDataValues(workflow, t);
        setConditionValues(workflow, t);
        taskExecutionQueue.push(taskFunction);
      }
    }
  }

  //Assuming we actually have any valid tasks to execute, let async call them in parallel
  if(taskExecutionQueue.length > 0) {

    //Now execute open tasks
    async.parallel(taskExecutionQueue,
      //function callback for async when all tasks have finsihed or an error has occured
      function(error, results) {
        //if no error then cycle through results and update the task statuses
        if(!error) {
          results.map(function(task){
            //if the task is open, set it to completed and update time stats
            if(task.status === 'open'){
              task.status = 'completed';
              task['time-completed'] = Date.now();
              task['handler-duration'] = task['time-completed'] - task['time-started'];
              task['total-duration'] = task['time-completed'] - task['time-opened'];
            }
            //logger.info("Task responded");
            //logger.info("Data\n" + JSON.stringify(task, null, 2));
          });

          //ok, all done and no error, so recurse into next set of tasks (if any)
          realExecute(workflow, callback);
        }
        else {
          results.map(function(task){
            //ok, error so set task to error
            task.status = 'error';
            task.data.error = error.message;
          });
          //Now set the overal workflow to error
          workflow.status = 'error';

          store.save(workflow, function(err){
            if(err){
              callback(err, workflow);
            }
          });
          callback(error, workflow);
        }
      });
  }
  else {
    //check if ALL tasks are completed, if so, set the workflow status
    if(childHasStatus(workflow, 'completed', true)){
      workflow.status = 'completed';
    }

    store.save(workflow, function(err){
      if(err){
        callback(err, workflow);
      }
    });
    //None left in the queue so callback
    callback(null, workflow);
  }
}

//check data values and look out for $[] references and update the value accordingly
function setTaskDataValues(workflow, task){
  var dataNames = Object.keys(task.data);
  for(var x=0; x<dataNames.length; x++){
    task.data[dataNames[x]] = setRefValue(workflow, task.data[dataNames[x]]);
  }
}

//Init all tasks to waiting and set workflow status to open
function setTaskStatusWaiting(workflow){
  workflow.status = 'open';
  scanAllTasks(workflow.tasks, true, function(task, name){
    if(!task.status) {
      task.status = 'waiting';
    }
    //continue scanning
    return true;
  });
}

//childHasStatus returns true if at least one of the children have the matching status
//Set all to true if ALL children should match that status
function childHasStatus(parent, status, all){

  var matchStatus = false;
  //are there child tasks, if not, return false;
  if(!parent.tasks) { return false; }

  scanAllTasks(parent.tasks, true, function(task, name){
      matchStatus = (task.status === status);
      if(matchStatus && !all) {
        //exit out of the scan
        return false;
      }
      if(!matchStatus && all){
        //exit out of the scan
        return false;
      }
      //continue scanning & checking
      return true;
  });

  return matchStatus;
}

//opens next available tasks and reurns if true if there are any waiting
function openNextAvailableTask(workflow){
  openTasks(workflow.tasks);
  //return true if there are any open tasks
  return childHasStatus(workflow, 'open', false);
}

//open any tasks that are 'ready' to be opened
function openTasks(tasks) {

  scanAllTasks(tasks, false, function(task, name){
    //If... we're still updating, the task is waiting and none of its children are waiting
    if(task.status ==='open'){
      //task is open, but does it have ANY children waiting?
      if(childHasStatus(task, 'waiting', false)){
        //it does, so let's go down and check those first
        openTasks(task.tasks);
      }
      //if the task is blocking return false to signify to scanAllTasks that we don't
      //to continue scanning
      return !task.blocking;
    }

    //the task is waiting, so let's open it and check its children (if any)
    if(task.status === "waiting"){
      task.status = 'open';
      task['time-opened'] = Date.now();
      //we've opened the task, so open it's children (if any)
      if(task.tasks){
        openTasks(task.tasks);
      }
      //if the task is blocking, then don't continue
      return !task.blocking;
    }

    //carry on!
    return true;
  });
}

//scan all tasks calling callback for each task a bit like 'map' for tasks
//set deep to true to recursively scan children
function scanAllTasks(tasks, deep, callback){
  var scanning = true;
  var taskNames = Object.keys(tasks);
  for (var x=0; x<taskNames.length; x++){
    //if the callback returns false then break
    scanning = callback(tasks[taskNames[x]], taskNames[x]);
    if (!scanning){
        //bubble up
        break;
    }
    //does the task have children, if scan recursively
    if(tasks[taskNames[x]].tasks && deep){
      scanning = scanAllTasks(tasks[taskNames[x]].tasks, true, callback);
      if (!scanning){
          break;
      }
    }
  }
  return scanning;
}

//get the data value of the task as reference by the . notation path
function getData(workflow, path){
  logger.debug("Getting data for path: " + path);
  pathElements = path.split(".");
  var obj = workflow;
  for (var x=0; x<pathElements.length; x++){
    //bug fix, only keep following the path if the object isn't undefined
    if(obj !== undefined) {
      obj = obj[pathElements[x]];
    }
  }

  if(obj === undefined){
    //it's undefined, so we can't get the data, that may be valid.... or not!
    logger.warn("Unable to get value for path " + path +". Did you set the path correctly?");
  }
  return obj;
}

function setConditionValues(workflow, task){

  //fetch any reference data values
  task.skip_if = setRefValue(workflow, task.skip_if);
  task.error_if = setRefValue(workflow, task.error_if);

  //now evaluate any conditions (if any)
  if(task.skip_if !== undefined) {
    task.skip_if = evalCondition(task.skip_if);
  }
  if(task.error_if !== undefined) {
    task.error_if = evalCondition(task.error_if);
  }

}

function setRefValue(workflow, ref) {
  if(typeof ref === "string"){
    startDelim = ref.indexOf("$[");
    endDelim = ref.indexOf("]");
    if (startDelim > -1){
      var path = ref.substring(startDelim +2, endDelim);
      var newValue = ref.substring(0, startDelim) + getData(workflow, path) + ref.substring(endDelim + 1, ref.length);
      logger.debug(ref + " has ref: " + path);
      logger.debug(ref + " de-referenced value is: " + newValue);
      return newValue;
    }
  }

  //can't convert it, so just return the ref(if it was a ref at all) supplied
  return ref;
}
//evaluate string conidition, but don't not in an eval() way
function evalCondition(condition) {
  logger.debug("evaluating condition " + condition);
  if(condition  === undefined) {
    return condition;
  }
  //check if the condition is a string, if not, just return it.
  if(!isString(condition)) {
    return condition;
  }

  //is it the string 'true'?
  return (/^true$/i).test(condition.trim().toLowerCase());

}

//is it a string literal or a String object (yeah, it's a javascript thing)
function isString(s) {
  return typeof(s) === 'string' || s instanceof String;
}