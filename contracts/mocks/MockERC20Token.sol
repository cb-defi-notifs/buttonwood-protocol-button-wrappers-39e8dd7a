pragma solidity 0.7.6;

import "./Mock.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockERC20Token is ERC20("Mock", "MCK") {
    function mint(address who, uint256 amount) external {
        _mint(who, amount);
    }

    function burn(address who, uint256 amount) external {
        _burn(who, amount);
    }
}
