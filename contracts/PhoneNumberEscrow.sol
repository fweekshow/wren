// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

/**
 * Holds ERC-20 funds against salted phone-number hashes until Basemate verifies
 * the recipient's Base Account address offchain.
 */
contract PhoneNumberEscrow {
    address public owner;
    mapping(address => bool) public operators;
    mapping(bytes32 => mapping(address => uint256)) public balances;

    event Deposited(bytes32 indexed phoneHash, address indexed token, address indexed sender, uint256 amount);
    event Released(bytes32 indexed phoneHash, address indexed token, address indexed recipient, uint256 amount);
    event Refunded(bytes32 indexed phoneHash, address indexed token, address indexed sender, uint256 amount);
    event OperatorUpdated(address indexed operator, bool enabled);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error NotOwner();
    error NotOperator();
    error InvalidAddress();
    error InvalidAmount();
    error InsufficientEscrow();
    error TransferFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyOperator() {
        if (msg.sender != owner && !operators[msg.sender]) revert NotOperator();
        _;
    }

    constructor(address initialOwner) {
        if (initialOwner == address(0)) revert InvalidAddress();
        owner = initialOwner;
        emit OwnershipTransferred(address(0), initialOwner);
    }

    function setOperator(address operator, bool enabled) external onlyOwner {
        if (operator == address(0)) revert InvalidAddress();
        operators[operator] = enabled;
        emit OperatorUpdated(operator, enabled);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function deposit(bytes32 phoneHash, address token, uint256 amount) external {
        if (phoneHash == bytes32(0) || token == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();

        balances[phoneHash][token] += amount;
        if (!IERC20(token).transferFrom(msg.sender, address(this), amount)) {
            revert TransferFailed();
        }

        emit Deposited(phoneHash, token, msg.sender, amount);
    }

    function release(bytes32 phoneHash, address token, address recipient) external onlyOperator returns (uint256 amount) {
        if (phoneHash == bytes32(0) || token == address(0) || recipient == address(0)) revert InvalidAddress();

        amount = balances[phoneHash][token];
        if (amount == 0) revert InsufficientEscrow();
        balances[phoneHash][token] = 0;

        if (!IERC20(token).transfer(recipient, amount)) {
            revert TransferFailed();
        }

        emit Released(phoneHash, token, recipient, amount);
    }

    function refund(bytes32 phoneHash, address token, address sender, uint256 amount) external onlyOperator {
        if (phoneHash == bytes32(0) || token == address(0) || sender == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();

        uint256 available = balances[phoneHash][token];
        if (available < amount) revert InsufficientEscrow();
        balances[phoneHash][token] = available - amount;

        if (!IERC20(token).transfer(sender, amount)) {
            revert TransferFailed();
        }

        emit Refunded(phoneHash, token, sender, amount);
    }
}
