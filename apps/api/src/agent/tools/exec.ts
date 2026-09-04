// One definition for both exec tools, so what the model is told about argv
// cannot drift between Docker and Kubernetes.
export const EXECUTABLE_PROPERTY = {
  type: "string",
  description:
    "The program to run, named on its own with no arguments and no spaces, for example redis-cli. Put every argument in args.",
} as const;

export const ARGS_PROPERTY = {
  type: "array",
  items: { type: "string" },
  description:
    "The program's arguments, one array element per argument, for example ['info', 'memory']. Omit it to run the program with no arguments. Each element reaches the program exactly as written, so quote nothing and escape nothing.",
} as const;
