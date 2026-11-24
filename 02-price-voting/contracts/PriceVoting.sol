// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/*
 * Note on withdrawing locked tokens BEFORE votingEnd:
 * If voters could withdraw their locked tokens before `votingEnd` without adjusting their recorded
 * vote weights, the per-price accumulated weight (and leader/highest-weight tracking) would stay
 * inflated and out of sync with the tokens actually locked in the contract. A voter could lock
 * tokens to push a proposed price into the lead, withdraw their tokens back before `votingEnd`, and
 * still leave that stake behind to determine the final `currentTokenPrice`.
 */

contract PriceVoting {
    IERC20 public immutable token;
    uint256 public immutable votingEnd;

    uint256 public currentTokenPrice;
    uint256 public highestWeight;
    uint256 public leaderPrice;
    uint256 public tiedPricesCount;
    bool public finalized;

    mapping(uint256 => uint256) public priceWeight;
    mapping(address => mapping(uint256 => uint256)) public voterPriceWeight;
    mapping(address => uint256) public lockedBalance;

    error VotingEnded();
    error VotingActive();
    error AlreadyFinalized();
    error ZeroAmount();
    error NothingToClaim();
    error TransferFailed();

    event Voted(address indexed voter, uint256 indexed price, uint256 amount);
    event PriceFinalized(uint256 winningPrice, uint256 winningWeight);
    event Claimed(address indexed voter, uint256 amount);

    constructor(address token_, uint256 votingEnd_) {
        token = IERC20(token_);
        votingEnd = votingEnd_;
    }

    function weightOf(uint256 price) external view returns (uint256) {
        return priceWeight[price];
    }

    function lockedOf(address account) external view returns (uint256) {
        return lockedBalance[account];
    }

    function vote(uint256 price, uint256 amount) external {
        if (block.timestamp >= votingEnd) revert VotingEnded();
        if (amount == 0) revert ZeroAmount();

        bool ok = token.transferFrom(msg.sender, address(this), amount);
        if (!ok) revert TransferFailed();

        voterPriceWeight[msg.sender][price] += amount;
        lockedBalance[msg.sender] += amount;

        uint256 updatedWeight = priceWeight[price] + amount;
        priceWeight[price] = updatedWeight;

        if (updatedWeight > highestWeight) {
            highestWeight = updatedWeight;
            leaderPrice = price;
            tiedPricesCount = 1;
        } else if (updatedWeight == highestWeight && updatedWeight > 0) {
            if (price != leaderPrice) {
                tiedPricesCount += 1;
            }
        }

        emit Voted(msg.sender, price, amount);
    }

    function finalize() external {
        if (block.timestamp < votingEnd) revert VotingActive();
        if (finalized) revert AlreadyFinalized();

        finalized = true;
        uint256 winningPrice = (highestWeight == 0 || tiedPricesCount > 1) ? 0 : leaderPrice;
        currentTokenPrice = winningPrice;

        emit PriceFinalized(winningPrice, highestWeight);
    }

    function claim() external {
        if (block.timestamp < votingEnd) revert VotingActive();

        uint256 amount = lockedBalance[msg.sender];
        if (amount == 0) revert NothingToClaim();

        lockedBalance[msg.sender] = 0;

        bool ok = token.transfer(msg.sender, amount);
        if (!ok) revert TransferFailed();

        emit Claimed(msg.sender, amount);
    }
}