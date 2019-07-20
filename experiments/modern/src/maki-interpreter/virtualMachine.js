const Variable = require("./variable");

function coerceTypes(var1, var2, val1, val2) {
  if (var2.type === "INT") {
    if (var1.type === "FLOAT" || var1.type === "DOUBLE") {
      return Math.floor(val1);
    }
  }

  return val1;
}

async function interpret(start, program, stack = [], { logger = null }) {
  const { commands, methods, variables, classes, offsetToCommand } = program;

  function twoArgCoercingOperator(operator) {
    const a = stack.pop();
    const b = stack.pop();
    let aValue = a instanceof Variable ? a.getValue() : a;
    const bValue = b instanceof Variable ? b.getValue() : b;

    aValue = coerceTypes(a, b, aValue, bValue);
    stack.push(operator(bValue, aValue));
  }

  function twoArgOperator(operator) {
    const a = stack.pop();
    const b = stack.pop();
    const aValue = a instanceof Variable ? a.getValue() : a;
    const bValue = b instanceof Variable ? b.getValue() : b;

    stack.push(operator(bValue, aValue));
  }

  function jumpToOffset(offset) {
    const nextCommandIndex = offsetToCommand[offset];
    return nextCommandIndex - 1;
  }

  let i = start;
  while (i < commands.length) {
    const command = commands[i];
    // Print some debug info
    if (logger) {
      // Remove this await when we can run the VM synchronously.
      // See GitHub issue #814
      await logger({ i, command, stack, variables, program });
    }

    switch (command.opcode) {
      // push
      case 1: {
        const offsetIntoVariables = command.arg;
        stack.push(variables[offsetIntoVariables]);
        break;
      }
      // pop
      case 2: {
        stack.pop();
        break;
      }
      // popTo
      case 3: {
        const a = stack.pop();
        let aValue = a instanceof Variable ? a.getValue() : a;
        const offsetIntoVariables = command.arg;
        const toVar = variables[offsetIntoVariables];
        toVar.setValue(aValue);
        break;
      }
      // ==
      case 8: {
        twoArgCoercingOperator((b, a) => b === a);
        break;
      }
      // !=
      case 9: {
        twoArgCoercingOperator((b, a) => b !== a);
        break;
      }
      // >
      case 10: {
        twoArgCoercingOperator((b, a) => b > a);
        break;
      }
      // >=
      case 11: {
        twoArgCoercingOperator((b, a) => b >= a);
        break;
      }
      // <
      case 12: {
        twoArgCoercingOperator((b, a) => b < a);
        break;
      }
      // <=
      case 13: {
        twoArgCoercingOperator((b, a) => b <= a);
        break;
      }
      // jumpIf
      case 16: {
        const value = stack.pop();
        // This seems backwards. Seems like we're doing a "jump if not"
        if (value) {
          break;
        }
        i = jumpToOffset(command.arg);
        break;
      }
      // jumpIfNot
      case 17: {
        const value = stack.pop();
        // This seems backwards. Same as above
        if (!value) {
          break;
        }
        i = jumpToOffset(command.arg);
        break;
      }
      // jump
      case 18: {
        i = jumpToOffset(command.arg);
        break;
      }
      // call
      // strangeCall (seems to behave just like regular call)
      case 24:
      case 112: {
        const methodOffset = command.arg;
        const { name: methodName, typeOffset: classesOffset } = methods[
          methodOffset
        ];
        const klass = classes[classesOffset];
        // This is a bit awkward. Because the variables are stored on the stack
        // before the object, we have to find the number of arguments without
        // actually having access to the object instance.
        let argCount = klass.prototype[methodName].length;

        const methodArgs = [];
        while (argCount--) {
          methodArgs.push(stack.pop().getValue());
        }
        const variable = stack.pop();
        const obj = variable.getValue();
        stack.push(obj[methodName](...methodArgs));
        break;
      }
      // callGlobal
      case 25: {
        const offset = command.arg;
        const nextCommandIndex = offsetToCommand[offset];
        // Remove this await when we can run the VM synchronously.
        // See GitHub issue #814
        const value = await interpret(nextCommandIndex, program, stack, {
          logger,
        });
        stack.push(value);
        break;
      }
      // return
      case 33: {
        const a = stack.pop();
        const aValue = a instanceof Variable ? a.getValue() : a;
        return aValue;
      }
      // mov
      case 48: {
        const a = stack.pop();
        const b = stack.pop();
        let aValue = a instanceof Variable ? a.getValue() : a;
        if (b.type === "INT") {
          aValue = Math.floor(aValue);
        }
        b.setValue(aValue);
        stack.push(aValue);
        break;
      }
      // postinc
      case 56: {
        const a = stack.pop();
        const aValue = a.getValue();
        a.setValue(aValue + 1);
        stack.push(aValue);
        break;
      }
      // postdec
      case 57: {
        const a = stack.pop();
        const aValue = a.getValue();
        a.setValue(aValue - 1);
        stack.push(aValue);
        break;
      }
      // preinc
      case 58: {
        const a = stack.pop();
        const aValue = a.getValue() + 1;
        a.setValue(aValue);
        stack.push(aValue);
        break;
      }
      // predec
      case 59: {
        const a = stack.pop();
        const aValue = a.getValue() - 1;
        a.setValue(aValue);
        stack.push(aValue);
        break;
      }
      // + (add)
      case 64: {
        twoArgOperator((b, a) => b + a);
        break;
      }
      // - (subtract)
      case 65: {
        twoArgOperator((b, a) => b - a);
        break;
      }
      // * (multiply)
      case 66: {
        twoArgOperator((b, a) => b * a);
        break;
      }
      // / (divide)
      case 67: {
        twoArgOperator((b, a) => b / a);
        break;
      }
      // % (mod)
      case 68: {
        const a = stack.pop();
        const b = stack.pop();
        const aValue = a instanceof Variable ? a.getValue() : a;
        let bValue = b instanceof Variable ? b.getValue() : b;
        // Need to coerce LHS if not int, RHS is always int (enforced by compiler)
        if (b.type === "FLOAT" || b.type === "DOUBLE") {
          bValue = Math.floor(bValue);
        }
        stack.push(bValue % aValue);
        break;
      }
      // & (binary and)
      case 72: {
        twoArgOperator((b, a) => b & a);
        break;
      }
      // | (binary or)
      case 73: {
        twoArgOperator((b, a) => b | a);
        break;
      }
      // ! (not)
      case 74: {
        const a = stack.pop();
        const aValue = a instanceof Variable ? a.getValue() : a;
        stack.push(aValue ? 0 : 1);
        break;
      }
      // - (negative)
      case 76: {
        const a = stack.pop();
        const aValue = a instanceof Variable ? a.getValue() : a;
        stack.push(-aValue);
        break;
      }
      // logAnd (&&)
      case 80: {
        twoArgOperator((b, a) => b && a);
        break;
      }
      // logOr ||
      case 81: {
        twoArgOperator((b, a) => b || a);
        break;
      }
      // <<
      case 88: {
        twoArgOperator((b, a) => b << a);
        break;
      }
      // >>
      case 89: {
        twoArgOperator((b, a) => b >> a);
        break;
      }
      default:
        throw new Error(`Unhandled opcode ${command.opcode}`);
    }

    i++;
  }
}

module.exports = interpret;
