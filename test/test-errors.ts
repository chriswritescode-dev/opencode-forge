// Test file with intentional TypeScript errors for testing

import { NonExistentModule } from 'non-existent-package';
import { readFile } from 'fs/promises';

// Error 1: Type mismatch
const count: number = "not a number";

// Error 2: Missing return type
function add(a: number, b: number) {
  return a + b;
}

// Error 3: Unused variable
const unusedVar = "this is never used";

// Error 4: Any type usage
function processAnything(data: any): any {
  return data;
}

// Error 5: Missing parameter type
function multiply(x, y: number): number {
  return x * y;
}

// Error 6: Accessing non-existent property
interface User {
  id: number;
  name: string;
}

const user: User = { id: 1, name: "Test" };
console.log(user.email); // Property 'email' does not exist

// Error 7: Async/await misuse
async function fetchData() {
  const result = readFile('missing-file.txt'); // Missing await
  return result;
}

// Error 8: Null/undefined issue
let maybeString: string | null = null;
const length = maybeString.length; // Object is possibly 'null'

// Error 9: Wrong number of arguments
const arr = [1, 2, 3];
arr.push(4, 5, 6); // This is actually valid, but let's add another error

// Error 10: Enum mismatch
enum Status {
  Active = "ACTIVE",
  Inactive = "INACTIVE"
}

function getStatus(): Status {
  return "UNKNOWN" as Status; // Type 'string' is not assignable
}

// Error 11: Missing required property
interface Config {
  host: string;
  port: number;
  enabled: boolean;
}

const config: Config = {
  host: "localhost",
  // Missing port and enabled
};

// Error 12: Incorrect generic type
const numbers: Array<number> = [1, 2, 3];
numbers.push("not a number");

// Error 13: Duplicate identifier
const duplicate = "first";
const duplicate = "second";

// Error 14: Export not found
export { NonExistentExport } from './non-existent-file';

// Error 15: Circular reference potential
interface Node {
  value: number;
  next: Node | null;
}

function createCircular(): Node {
  const node: Node = { value: 1, next: null };
  node.next = node; // Creates circular reference
  return node;
}

export { add, processAnything, multiply, fetchData, getStatus, createCircular };
