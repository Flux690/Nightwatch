import Ajv from "ajv";

const ajv = new Ajv({ allErrors: true, strict: false });

export function validateSchema<T>(
  schema: object,
  data: unknown,
  name: string,
): T {
  const validate = ajv.compile(schema);
  if (!validate(data)) {
    throw new Error(
      `[${name} schema invalid] ${ajv.errorsText(validate.errors)}`,
    );
  }
  return data as T;
}
