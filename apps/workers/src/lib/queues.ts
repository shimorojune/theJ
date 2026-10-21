import { createQueues } from "@thej/core";
import { connection } from "./redis";

export const queues = createQueues(connection);
export const { fetch: fetchQueue, analyse: analyseQueue, enqueueFetch, enqueueAnalyse } = queues;
