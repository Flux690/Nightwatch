import { z } from "zod";

// One definition for both exec tools, so what the model is told about argv
// cannot drift between Docker and Kubernetes.
export const executable = z.string().meta({
  description:
    "The program to run, named on its own with no arguments and no spaces, for example redis-cli. Put every argument in args.",
});

export const args = z.array(z.string()).optional().meta({
  description:
    "The program's arguments, one array element per argument, for example ['info', 'memory']. Omit it to run the program with no arguments. Each element reaches the program exactly as written, so quote nothing and escape nothing.",
});
